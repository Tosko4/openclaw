import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { buildHistoryContext } from "../../auto-reply/reply/history.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
  PersistedUserTurnMessage,
} from "../../sessions/user-turn-input.types.js";
import { hasConversationHistorySchema } from "../../state/openclaw-agent-conversation-history-schema.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { StoredObservation } from "./conversation-history-observation.js";
import {
  readSessionPendingInputOwnerIds,
  runWithSessionPendingInput,
  type SessionPendingInputOwner,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
} from "../../sessions/user-turn-input.types.js";

type HistoryDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;
type ConversationHistorySelection = {
  rows: readonly { seq: number; source_id: string; message_json: string }[];
  references: readonly { seq: number; custody_json: string }[];
  recoveredInputIds: readonly string[];
};
export function throwPendingInputTooLarge(): never {
  const userMessage =
    `This request and its unread conversation exceed the ${MAX_PAYLOAD_BYTES / (1024 * 1024)} MiB input limit. ` +
    "Nothing was sent. Use /new to start fresh without unread conversation; in a group, send it as a reply to this message. Then send a shorter request.";
  throw new AgentHarnessPreflightError(userMessage, { userMessage });
}
const submissionAttempts = new WeakMap<SessionPendingInputOwner, object>();

/** Persist uncertainty before handoff; only this exact live attempt may undo a definitive rejection. */
export function beginConversationHistorySubmission(owner: SessionPendingInputOwner): {
  rejectSubmission: () => void;
} {
  const sources = owner.sources ?? [owner];
  const inputIds = sources.map((source) => source.inputId);
  const attempt = {};
  const tracked = runWithSessionPendingInput(owner, () =>
    runOpenClawAgentWriteTransaction((database) => {
      runWithSessionPendingInput(owner, () => {});
      if (!hasConversationHistorySchema(database.db)) {
        return false;
      }
      const db = getSessionKysely(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("conversation_history")
          .select("submission_started")
          .where("assigned_input_id", "in", inputIds)
          .where("consumed_session_id", "is", null),
      ).rows;
      if (!rows.length) {
        return false;
      }
      const pending = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_pending_inputs").selectAll().where("input_id", "in", inputIds),
      ).rows;
      if (
        readSessionPendingInputOwnerIds(database, pending).size !== pending.length ||
        pending.some((row) => row.state !== "queued") ||
        rows.some((row) => row.submission_started !== 0)
      ) {
        throw new Error("Pending input submission is already started or its custody ended");
      }
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("conversation_history")
          .set({ submission_started: 1 })
          .where("assigned_input_id", "in", inputIds)
          .where("consumed_session_id", "is", null),
      );
      return true;
    }, owner.databaseOptions),
  );
  if (!tracked) {
    return { rejectSubmission: () => {} };
  }
  for (const source of sources) {
    submissionAttempts.set(source, attempt);
  }
  return {
    rejectSubmission: () =>
      runWithSessionPendingInput(owner, () => {
        if (sources.some((source) => submissionAttempts.get(source) !== attempt)) {
          throw new Error("Pending input rejection belongs to a closed submission attempt");
        }
        runOpenClawAgentWriteTransaction((database) => {
          runWithSessionPendingInput(owner, () => {});
          const pending = executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_pending_inputs")
              .selectAll()
              .where("input_id", "in", inputIds),
          ).rows;
          if (
            readSessionPendingInputOwnerIds(database, pending).size !== pending.length ||
            pending.some((row) => row.state !== "queued")
          ) {
            throw new Error("Pending input rejection cannot reopen ended custody");
          }
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("conversation_history")
              .set({ submission_started: 0 })
              .where("assigned_input_id", "in", inputIds)
              .where("consumed_session_id", "is", null)
              .where("submission_started", "=", 1),
          );
        }, owner.databaseOptions);
        for (const source of sources) {
          submissionAttempts.delete(source);
        }
      }),
  };
}

/** Session reset and unread retirement commit together; active submissions keep their evidence. */
export function resetConversationHistory(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): void {
  if (database.path !== capture.owner.databasePath) {
    throw new Error("Conversation observation owner changed before reset");
  }
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  const db = getSessionKysely(database.db);
  const unread = db
    .selectFrom("conversation_history")
    .where("agent_id", "=", capture.owner.agentId)
    .where("conversation_ref", "=", capture.conversationRef)
    .where("seq", "<=", capture.throughSequence)
    .where("consumed_session_id", "is", null);
  const rows = executeSqliteQuerySync(
    database.db,
    unread
      .select(["seq", "source_id", "assigned_input_id", "submission_started"])
      .select((eb) =>
        eb
          .fn<string>("json_extract", ["message_json", eb.val("$.observationCustody")])
          .as("custody_json"),
      ),
  ).rows.filter(
    (row) =>
      // SAFETY: custody_json projects the typed intake owner's observationCustody.
      !(JSON.parse(row.custody_json) as StoredObservation["observationCustody"]).retiredByReset &&
      !capture.requestSourceIds.includes(row.source_id),
  );
  const inputIds = [
    ...new Set(rows.flatMap((row) => (row.assigned_input_id ? [row.assigned_input_id] : []))),
  ];
  const pending = inputIds.flatMap(
    (inputId) =>
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_pending_inputs")
          .select(["input_id", "session_id", "session_key", "lifecycle_generation"])
          .where("input_id", "=", inputId),
      ).rows,
  );
  if (readSessionPendingInputOwnerIds(database, pending).size) {
    throw new AgentHarnessPreflightError("Conversation history has an unfinished submission", {
      userMessage:
        "A previous request still owns some conversation history. Wait for or cancel the active request, then reset again. Its history has been kept.",
    });
  }
  for (const inputId of inputIds) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_pending_inputs")
        .set({ state: "cancelled" })
        .where("input_id", "=", inputId)
        .where("consumed_event_id", "is", null),
    );
  }
  const retiredByReset = { sourceIds: capture.requestSourceIds, time: Date.now() };
  for (const row of rows) {
    if (row.assigned_input_id !== null || row.submission_started !== 0) {
      // Reset retires uncertainty; it does not claim delivery or erase the prior
      // input's receipt, source assignment, or submission evidence.
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("conversation_history")
          .set((eb) => ({
            message_json: eb.fn<string>("json_set", [
              "message_json",
              eb.val("$.observationCustody.retiredByReset"),
              eb.fn<string>("json", [eb.val(JSON.stringify(retiredByReset))]),
            ]),
          }))
          .where("seq", "=", row.seq),
      );
    } else {
      // The ingress spool can replay after reset. Keep its source identity while
      // clearing the old body, so redelivery cannot recreate unread history.
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("conversation_history")
          .set({
            message_json: JSON.stringify({
              observationCustody: {
                // SAFETY: The reset query selected the stored observationCustody object.
                ...(JSON.parse(row.custody_json) as StoredObservation["observationCustody"]),
                retiredByReset,
              },
            }),
          })
          .where("seq", "=", row.seq),
      );
    }
  }
}

export function isConversationHistoryInputUnsubmitted(
  database: HistoryDatabase,
  inputId: string,
): boolean {
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("conversation_history")
      .select("submission_started")
      .where("assigned_input_id", "=", inputId)
      .where("consumed_session_id", "is", null),
  ).rows;
  return rows.length > 0 && rows.every((row) => row.submission_started === 0);
}

function recoverableHistoryInputIds(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): string[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_pending_inputs")
      .select(["input_id", "session_id", "session_key", "lifecycle_generation"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("conversation_history")
            .select("seq")
            .whereRef("assigned_input_id", "=", "session_pending_inputs.input_id")
            .where("agent_id", "=", capture.owner.agentId)
            .where("conversation_ref", "=", capture.conversationRef)
            .where("seq", "<=", capture.throughSequence)
            .where("consumed_session_id", "is", null)
            .where("submission_started", "=", 0)
            .where("assigned_input_id", "is not", null),
        ),
      )
      .where("consumed_event_id", "is", null)
      .where("state", "in", ["queued", "interrupted"])
      .where("lifecycle_generation", "!=", getAgentEventLifecycleGeneration()),
  ).rows;
  const owned = readSessionPendingInputOwnerIds(database, rows);
  return rows
    .filter(
      (row) =>
        !owned.has(row.input_id) && isConversationHistoryInputUnsubmitted(database, row.input_id),
    )
    .map((row) => row.input_id);
}

function unreadHistory(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
  recoverableInputIds: readonly string[] = [],
) {
  return getSessionKysely(database.db)
    .selectFrom("conversation_history")
    .where("agent_id", "=", capture.owner.agentId)
    .where("conversation_ref", "=", capture.conversationRef)
    .where("seq", "<=", capture.throughSequence)
    .where("submission_started", "=", 0)
    .where((eb) =>
      recoverableInputIds.length
        ? eb.or([
            eb("assigned_input_id", "is", null),
            eb("assigned_input_id", "in", [...recoverableInputIds]),
          ])
        : eb("assigned_input_id", "is", null),
    )
    .where("consumed_session_id", "is", null);
}

/** Prepare complete context before hooks; the insertion transaction rechecks the captured range. */
export async function prepareConversationHistoryInput(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
): Promise<{
  historyText: string;
  backgroundMedia: NonNullable<ConversationHistoryMessage["media"]>;
  selection: ConversationHistorySelection;
}> {
  const requestSources = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("conversation_history")
      .select([
        "seq",
        "source_id",
        "assigned_input_id",
        "consumed_session_id",
        "submission_started",
      ])
      .select((eb) =>
        eb
          .fn<string>("json_extract", ["message_json", eb.val("$.observationCustody")])
          .as("custody_json"),
      )
      .where("agent_id", "=", capture.owner.agentId)
      .where("conversation_ref", "=", capture.conversationRef)
      .where("source_id", "in", [...capture.requestSourceIds])
      .where("seq", "<=", capture.throughSequence),
  ).rows.map((row) => ({
    row,
    // SAFETY: The source query extracts typed intake's observationCustody object.
    custody: JSON.parse(row.custody_json) as StoredObservation["observationCustody"],
  }));
  const references = requestSources.filter(
    ({ row, custody }) =>
      !custody.request &&
      !custody.retiredByReset &&
      (row.assigned_input_id !== null || row.consumed_session_id !== null),
  );
  if (
    references.length &&
    !requestSources.some(
      ({ row, custody }) =>
        custody.request === "reserved" &&
        !custody.retiredByReset &&
        row.assigned_input_id === null &&
        row.consumed_session_id === null &&
        row.submission_started === 0,
    )
  ) {
    throw new Error("Conversation request requires a fresh addressed source");
  }
  // A later caption can reference a photo already used as passive context.
  // The fresh addressed anchor owns this request; the prior owner keeps its sources.
  const referenceSequences = new Set(references.map(({ row }) => row.seq));
  const referenceInputIds = new Set(references.map(({ row }) => row.assigned_input_id));
  const recoveredInputIds = recoverableHistoryInputIds(database, capture).filter(
    (id) => !referenceInputIds.has(id),
  );
  const requestIds = new Set(capture.requestSourceIds);
  const sourceIds = new Set(references.map(({ row }) => row.source_id));
  const selectedRows: { seq: number; source_id: string; message_json: string }[] = [];
  const background: ConversationHistoryMessage[] = [];
  let sequence = 0;
  let selectedBytes = 0;
  let projectedTextBytes = 0;
  while (true) {
    const query = unreadHistory(database, capture, recoveredInputIds)
      .where("seq", ">", sequence)
      .orderBy("seq", "asc")
      .limit(1);
    // 2026-09-11: escaped backlog exceeded 1 GiB RSS before rejection. Read
    // byte metadata first and retain at most the existing input byte budget.
    const metadata = executeSqliteQueryTakeFirstSync(
      database.db,
      query
        .select(["seq", "source_id"])
        .select((eb) =>
          eb
            .fn<string>("json_extract", ["message_json", eb.val("$.observationCustody")])
            .as("custody_json"),
        )
        .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes")),
    );
    if (!metadata) {
      break;
    }
    sequence = metadata.seq;
    // SAFETY: The bounded query projects observationCustody from intake-owned JSON.
    const custody = JSON.parse(metadata.custody_json) as StoredObservation["observationCustody"];
    const isRequest = requestIds.has(metadata.source_id);
    if (
      referenceSequences.has(metadata.seq) ||
      custody.retiredByReset ||
      (!isRequest && custody.request === "reserved")
    ) {
      await setImmediate();
      continue;
    }
    if (metadata.bytes > MAX_PAYLOAD_BYTES) {
      throwPendingInputTooLarge();
    }
    const row = executeSqliteQueryTakeFirstSync(database.db, query.selectAll());
    if (!row) {
      throw new Error("Conversation observation changed during preparation");
    }
    sequence = row.seq;
    const { observationCustody: _custody, ...input } = JSON.parse(
      row.message_json,
    ) as StoredObservation; // SAFETY: Intake and custody writers preserve this shape.
    if (isRequest || !capture.includeMessage || (await capture.includeMessage(input))) {
      selectedBytes += metadata.bytes;
      if (!isRequest) {
        // Both framed content and observedInput.context carry this escaped text.
        projectedTextBytes += 2 * Buffer.byteLength(JSON.stringify(input.text ?? ""), "utf8");
      }
      if (selectedBytes > MAX_PAYLOAD_BYTES || projectedTextBytes > MAX_PAYLOAD_BYTES) {
        throwPendingInputTooLarge();
      }
      selectedRows.push({ seq: row.seq, source_id: row.source_id, message_json: row.message_json });
      sourceIds.add(row.source_id);
      if (!isRequest) {
        background.push(input);
      }
    }
    await setImmediate();
  }
  if (!requestIds.size || capture.requestSourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
    throw new Error("Conversation request was already captured or its source is unavailable");
  }
  const selection = {
    rows: selectedRows,
    references: references.map(({ row: { seq, custody_json } }) => ({ seq, custody_json })),
    recoveredInputIds,
  };
  const visibleMessageIds = new Set(
    background.flatMap((input) => (input.transport?.messageId ? [input.transport.messageId] : [])),
  );
  const historyLines: string[] = [];
  let renderedBytes = 0;
  for (const input of background) {
    const sender = input.sender?.name ?? input.sender?.username ?? input.sender?.id;
    const native = [
      ...(input.transport?.messageId ? [`message ${input.transport.messageId}`] : []),
      ...(input.transport?.replyToId ? [`reply to ${input.transport.replyToId}`] : []),
    ];
    const timestamp =
      input.timestamp === undefined ? "" : `[${new Date(input.timestamp).toISOString()}] `;
    const lines = [
      `${timestamp}${native.length ? `[${native.join("; ")}] ` : ""}${sender ? `${sender}: ` : ""}${input.text ?? ""}`,
    ];
    const quote = input.replyTo;
    if (
      quote &&
      (!quote.messageId || !visibleMessageIds.has(quote.messageId)) &&
      (!capture.includeMessage || (await capture.includeMessage(quote, "quote")))
    ) {
      const quoteSender = quote.sender?.name ?? quote.sender?.username ?? quote.sender?.id;
      lines.push(
        `[Reply target${quote.messageId ? ` ${quote.messageId}` : ""}${quoteSender ? ` from ${quoteSender}` : ""}: ${JSON.stringify(quote.text ?? "")}]`,
      );
    }
    for (const media of input.media ?? []) {
      const reference = media.path ?? media.url;
      const attachment = JSON.stringify(media.fileName ?? media.kind ?? "file");
      lines.push(
        reference
          ? `[Attachment: ${attachment}; reference: ${reference}]`
          : `[Attachment: ${attachment}; unavailable; ask the sender to resend it]`,
      );
    }
    const line = lines.join("\n");
    renderedBytes += 2 * Buffer.byteLength(JSON.stringify(line), "utf8");
    if (renderedBytes > MAX_PAYLOAD_BYTES) {
      throwPendingInputTooLarge();
    }
    historyLines.push(line);
  }
  const historyText = historyLines.join("\n");
  const backgroundMedia = background.flatMap((input) => input.media ?? []);
  // These decoded facts belong to this capture; saved source messages remain unchanged.
  for (const media of backgroundMedia) {
    media.hydrationSuppressed = true;
    media.contextOnly = true;
  }
  return {
    selection,
    historyText,
    backgroundMedia,
  };
}

/** Reapply selected context after the current request's write hooks have completed. */
export function projectConversationHistoryInput(
  message: PersistedUserTurnMessage,
  historyText: string,
  backgroundMedia: NonNullable<ConversationHistoryMessage["media"]>,
): PersistedUserTurnMessage {
  if (!historyText) {
    return message;
  }
  const framed = buildHistoryContext({
    historyText,
    currentMessage: typeof message.content === "string" ? message.content : "",
    historyMarker: "[Earlier chat messages - for context]",
  });
  return {
    ...message,
    __openclaw: {
      ...message["__openclaw"],
      observedInput: { context: historyText, request: message.content },
      ...(backgroundMedia.length
        ? { media: [...(readPersistedMediaFacts(message) ?? []), ...backgroundMedia] }
        : {}),
    },
    content:
      typeof message.content === "string"
        ? framed
        : [{ type: "text", text: framed }, ...message.content],
  };
}

/** Called with pending-input insertion so a failed capture leaves both owners unchanged. */
export function assignConversationHistoryInput(
  database: HistoryDatabase,
  capture: ConversationHistoryCapture,
  selection: ConversationHistorySelection,
  inputId: string,
): void {
  for (const reference of selection.references) {
    const current = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("conversation_history")
        .select("seq")
        .where("seq", "=", reference.seq)
        .where("agent_id", "=", capture.owner.agentId)
        .where("conversation_ref", "=", capture.conversationRef)
        .where((eb) =>
          eb(
            eb.fn<string>("json_extract", ["message_json", eb.val("$.observationCustody")]),
            "=",
            reference.custody_json,
          ),
        )
        .where((eb) =>
          eb.or([
            eb("assigned_input_id", "is not", null),
            eb("consumed_session_id", "is not", null),
          ]),
        ),
    );
    if (!current) {
      throw new Error("Referenced conversation source changed before input admission");
    }
  }
  if (selection.recoveredInputIds.length) {
    const recoverable = new Set(recoverableHistoryInputIds(database, capture));
    if (selection.recoveredInputIds.some((id) => !recoverable.has(id))) {
      throw new Error("Interrupted conversation input custody changed before recovery");
    }
    // Transfer old-generation context only with terminal cancellation of its former
    // request. Otherwise a later native retry could replay the same captured range.
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ state: "cancelled" })
        .where("input_id", "in", [...selection.recoveredInputIds]),
    );
    for (const recoveredInputId of selection.recoveredInputIds) {
      releaseCancelledConversationHistoryInput(database, recoveredInputId);
    }
  }
  for (const row of selection.rows) {
    const result = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("conversation_history")
        .set((eb) => ({
          assigned_input_id: inputId,
          submission_started: 0,
          message_json: capture.requestSourceIds.includes(row.source_id)
            ? eb.fn<string>("json_set", [
                "message_json",
                eb.val("$.observationCustody.request"),
                eb.val("admitted"),
              ])
            : row.message_json,
        }))
        .where("agent_id", "=", capture.owner.agentId)
        .where("conversation_ref", "=", capture.conversationRef)
        .where("seq", "=", row.seq)
        .where("message_json", "=", row.message_json)
        .where("submission_started", "=", 0)
        .where("assigned_input_id", "is", null)
        .where("consumed_session_id", "is", null),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        "Conversation history changed before input admission; submit the request again",
      );
    }
  }
}

export function releaseCancelledConversationHistoryInput(
  database: HistoryDatabase,
  inputId: string,
): void {
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .updateTable("conversation_history")
      .set({ assigned_input_id: null })
      .where("assigned_input_id", "=", inputId)
      .where("consumed_session_id", "is", null)
      .where("submission_started", "=", 0),
  );
}

/** Archive publication replaces a window; only removal of both owners ends source retention. */
export function pruneConsumedConversationHistory(
  database: HistoryDatabase,
  sessionId: string,
): void {
  if (!hasConversationHistorySchema(database.db)) {
    return;
  }
  const db = getSessionKysely(database.db);
  const window = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
  );
  if (window) {
    return;
  }
  const archiveTable = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("sqlite_schema").select("name").where("name", "=", "session_transcript_archives"),
  );
  if (
    archiveTable &&
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .limit(1),
    )
  ) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("conversation_history").where("consumed_session_id", "=", sessionId),
  );
}
