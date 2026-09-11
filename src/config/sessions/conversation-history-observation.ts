import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
import type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
} from "../../sessions/user-turn-input.types.js";
import { ensureConversationHistorySchema } from "../../state/openclaw-agent-conversation-history-schema.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";

export type StoredObservation = ConversationHistoryMessage & {
  observationCustody: {
    sourceFingerprint: string;
    request?: "reserved" | "admitted";
    retiredByReset?: { sourceIds: readonly string[]; time: number };
  };
};

function redactObservation(message: StoredObservation, config?: OpenClawConfig): StoredObservation {
  return {
    ...redactSecrets(message, config?.logging),
    observationCustody: message.observationCustody,
  };
}

/** Room observation owns no session generation and never admits an agent turn. */
export async function recordConversationObservationCore(
  scope: { agentId: string; storePath?: string; config?: OpenClawConfig },
  observation: {
    conversationRef: string;
    sourceId: string;
    message: ConversationHistoryMessage;
    isRequest?: boolean;
  },
): Promise<ConversationHistoryCapture> {
  const resolved = resolveSqliteReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const messageJson = JSON.stringify(
    redactObservation(
      {
        ...observation.message,
        observationCustody: {
          sourceFingerprint: createHash("sha256")
            .update(stableStringify(observation.message))
            .digest("hex"),
          ...(observation.isRequest ? { request: "reserved" as const } : {}),
        },
      },
      scope.config,
    ),
  );
  return withSqliteSessionDatabase(databaseOptions, (database) => {
    ensureConversationHistorySchema(database.db);
    return runOpenClawAgentWriteTransaction((current) => {
      const db = getSessionKysely(current.db);
      executeSqliteQuerySync(
        current.db,
        db
          .insertInto("conversation_history")
          .values({
            agent_id: resolved.agentId,
            conversation_ref: observation.conversationRef,
            source_id: observation.sourceId,
            message_json: messageJson,
            submission_started: 0,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "conversation_ref", "source_id"]).doNothing(),
          ),
      );
      const row = executeSqliteQueryTakeFirstSync(
        current.db,
        db
          .selectFrom("conversation_history")
          .selectAll()
          .where("agent_id", "=", resolved.agentId)
          .where("conversation_ref", "=", observation.conversationRef)
          .where("source_id", "=", observation.sourceId),
      );
      if (!row) {
        throw new Error("Conversation observation was not recorded");
      }
      // SAFETY: Intake serializes StoredObservation; updates retain its custody metadata.
      const original = JSON.parse(row.message_json) as StoredObservation;
      if (
        observation.isRequest &&
        !original.observationCustody.request &&
        !original.observationCustody.retiredByReset &&
        row.assigned_input_id === null &&
        row.consumed_session_id === null &&
        row.submission_started === 0
      ) {
        original.observationCustody.request = "reserved";
        executeSqliteQuerySync(
          current.db,
          db
            .updateTable("conversation_history")
            .set({ message_json: JSON.stringify(original) })
            .where("seq", "=", row.seq),
        );
      }
      return {
        owner: { agentId: resolved.agentId, databasePath: database.path },
        conversationRef: observation.conversationRef,
        throughSequence: row.seq,
        requestSourceIds: [observation.sourceId],
      };
    }, databaseOptions);
  });
}

/** Download completion enriches only its original observation, never a captured or reset input. */
export async function enrichConversationObservationCore(
  capture: ConversationHistoryCapture,
  sourceId: string,
  enrichment: { media: NonNullable<ConversationHistoryMessage["media"]>; text?: string },
  options: { config?: OpenClawConfig } = {},
): Promise<void> {
  if (!capture.requestSourceIds.includes(sourceId)) {
    throw new Error("Attachment source does not belong to this conversation observation");
  }
  const databaseOptions = toDatabaseOptions(
    resolveSqliteReadScope({
      agentId: capture.owner.agentId,
      storePath: capture.owner.databasePath,
    }),
  );
  await withSqliteSessionDatabase(databaseOptions, () =>
    runOpenClawAgentWriteTransaction((current) => {
      const query = getSessionKysely(current.db)
        .selectFrom("conversation_history")
        .selectAll()
        .where("agent_id", "=", capture.owner.agentId)
        .where("conversation_ref", "=", capture.conversationRef)
        .where("source_id", "=", sourceId)
        .where("seq", "<=", capture.throughSequence);
      const row = executeSqliteQueryTakeFirstSync(current.db, query);
      // Native redelivery must reuse the already admitted bytes. A reset must
      // not resurrect an observation whose download was still in flight.
      if (
        !row ||
        row.assigned_input_id !== null ||
        row.consumed_session_id !== null ||
        row.submission_started !== 0
      ) {
        return;
      }
      // SAFETY: Observation intake owns this JSON; enrichment preserves its source fields.
      const original = JSON.parse(row.message_json) as StoredObservation;
      if (
        original.observationCustody.retiredByReset ||
        original.media?.some((entry) => entry.path || entry.url)
      ) {
        // Redelivery may download another copy; keep the first source fingerprint stable.
        return;
      }
      executeSqliteQuerySync(
        current.db,
        getSessionKysely(current.db)
          .updateTable("conversation_history")
          .set({
            message_json: JSON.stringify(
              redactObservation({ ...original, ...enrichment }, options.config),
            ),
          })
          .where("seq", "=", row.seq),
      );
    }, databaseOptions),
  );
}

/** Buffered siblings acquire request custody together before another sender can capture them. */
export async function combineConversationHistoryCapturesCore(
  inputs: readonly (ConversationHistoryCapture | undefined)[],
): Promise<ConversationHistoryCapture | undefined> {
  const captures = inputs.filter((capture) => capture !== undefined);
  const first = captures[0];
  if (!first) {
    return undefined;
  }
  if (
    captures.some(
      (capture) =>
        capture.owner.agentId !== first.owner.agentId ||
        capture.owner.databasePath !== first.owner.databasePath ||
        capture.conversationRef !== first.conversationRef,
    )
  ) {
    throw new Error("Buffered conversation observations must have the same owner and conversation");
  }
  const capture = {
    ...first,
    throughSequence: Math.max(...captures.map((entry) => entry.throughSequence)),
    requestSourceIds: [...new Set(captures.flatMap((entry) => entry.requestSourceIds))],
  };
  const options = toDatabaseOptions(
    resolveSqliteReadScope({ agentId: first.owner.agentId, storePath: first.owner.databasePath }),
  );
  await withSqliteSessionDatabase(options, () =>
    runOpenClawAgentWriteTransaction((database) => {
      const db = getSessionKysely(database.db);
      const rows = capture.requestSourceIds
        .flatMap(
          (sourceId) =>
            executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("conversation_history")
                .select(["seq", "assigned_input_id", "consumed_session_id", "submission_started"])
                .select((eb) =>
                  eb
                    .fn<string>("json_extract", ["message_json", eb.val("$.observationCustody")])
                    .as("custody_json"),
                )
                .where("agent_id", "=", capture.owner.agentId)
                .where("conversation_ref", "=", capture.conversationRef)
                .where("source_id", "=", sourceId)
                .where("seq", "<=", capture.throughSequence),
            ).rows,
        )
        .map((row) => ({
          row,
          // SAFETY: The query extracts observationCustody written by typed intake.
          custody: JSON.parse(row.custody_json) as StoredObservation["observationCustody"],
        }));
      if (!rows.some(({ custody }) => custody.request === "reserved")) {
        return;
      }
      for (const { row, custody } of rows) {
        if (
          row.assigned_input_id !== null ||
          row.consumed_session_id !== null ||
          row.submission_started !== 0 ||
          custody.retiredByReset ||
          custody.request
        ) {
          continue;
        }
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("conversation_history")
            .set((eb) => ({
              message_json: eb.fn<string>("json_set", [
                "message_json",
                eb.val("$.observationCustody.request"),
                eb.val("reserved"),
              ]),
            }))
            .where("seq", "=", row.seq),
        );
      }
    }, options),
  );
  return capture;
}

/** Bind replay to the complete native request, not its later model-prompt projection. */
export function fingerprintConversationHistoryRequest(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  capture: ConversationHistoryCapture,
): string {
  const sourceIds = [...new Set(capture.requestSourceIds)];
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("conversation_history")
      .select("source_id")
      .select((eb) =>
        eb
          .fn<string | null>("json_extract", [
            "message_json",
            eb.val("$.observationCustody.retiredByReset"),
          ])
          .as("retired_by_reset"),
      )
      .select((eb) =>
        eb
          .fn<string>("json_extract", [
            "message_json",
            eb.val("$.observationCustody.sourceFingerprint"),
          ])
          .as("source_fingerprint"),
      )
      .where("agent_id", "=", capture.owner.agentId)
      .where("conversation_ref", "=", capture.conversationRef)
      .where("source_id", "in", sourceIds)
      .where("seq", "<=", capture.throughSequence)
      .orderBy("seq", "asc"),
  ).rows;
  if (!sourceIds.length || rows.length !== sourceIds.length) {
    throw new Error("Native request source is unavailable for durable admission");
  }
  if (rows.some((row) => row.retired_by_reset !== null)) {
    const userMessage =
      "This request was cleared by a conversation reset. Send a new message to continue.";
    throw new AgentHarnessPreflightError(userMessage, { userMessage });
  }
  return createHash("sha256")
    .update(
      stableStringify({
        agentId: capture.owner.agentId,
        conversationRef: capture.conversationRef,
        sources: rows.map((row) => ({
          sourceId: row.source_id,
          fingerprint: row.source_fingerprint,
        })),
      }),
    )
    .digest("hex");
}
