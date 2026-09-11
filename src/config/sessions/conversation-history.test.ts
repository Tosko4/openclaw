import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  recordConversationObservationCore,
  combineConversationHistoryCapturesCore,
  enrichConversationObservationCore,
} from "./conversation-history-observation.js";
import {
  resetConversationHistory,
  type ConversationHistoryCapture,
  type ConversationHistoryMessage,
} from "./conversation-history.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  claimSessionPendingInputDedupeRecovery,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("durable conversation history custody", () => {
  const fixture = useTempSessionsFixture("openclaw-conversation-history-");
  const sessionKey = "agent:main:group-history";
  const sessionId = "history-session";
  const conversationRef = "conv_group";
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({ agentId: "main", storePath: fixture.storePath() });
  const sessionScope = () => ({ ...scope(), sessionKey, sessionId });
  const database = () =>
    openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope())));
  const observe = (
    sourceId: string,
    message: ConversationHistoryMessage = { text: sourceId, sender: { name: "Alice" } },
    conversation = conversationRef,
  ) =>
    recordConversationObservationCore(scope(), {
      conversationRef: conversation,
      sourceId,
      message,
    });
  const input = (runId: string): PersistedUserTurnMessage => ({
    role: "user",
    content: runId,
    timestamp: 1,
    idempotencyKey: runId,
  });
  const stage = async (
    runId: string,
    conversationHistory: ConversationHistoryCapture,
    prepareMessageAfterIdempotencyCheck?: (
      message: PersistedUserTurnMessage,
    ) => PersistedUserTurnMessage,
  ) => {
    const receipt = await stageSessionPendingInput(sessionScope(), {
      runId,
      message: input(runId),
      conversationHistory,
      prepareMessageAfterIdempotencyCheck,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Test input was not admitted");
    }
    receipts.push(receipt);
    return receipt;
  };
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(sessionScope(), { message: receipt.message }));

  beforeEach(async () => {
    await upsertSessionEntryCore(sessionScope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  it("keeps existing stores history-free until their first room observation", async () => {
    const db = database().db;
    db.exec("DROP TABLE conversation_history");
    const receipt = await stageSessionPendingInput(sessionScope(), {
      runId: "ordinary-input",
      message: input("ordinary-input"),
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Ordinary input was not admitted");
    }
    receipts.push(receipt);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'conversation_history'").get(),
    ).toBeUndefined();
    const capture = await observe("first-observation");
    expect(capture.requestSourceIds).toEqual(["first-observation"]);
    expect(db.prepare("SELECT source_id FROM conversation_history").all()).toEqual([
      { source_id: "first-observation" },
    ]);
  });

  it("retains every unread message across reopen, freezes the request boundary and consumes once", async () => {
    for (let index = 0; index < 100; index += 1) {
      await observe(`message-${index}`);
    }
    await observe("other-room", { text: "private to another room" }, "conv_other");
    const capture = await observe("first-request");
    expect(await observe("first-request")).toEqual(capture);
    closeOpenClawAgentDatabasesForTest();
    await observe("arrived-after-request");
    const first = await stage("first-request", capture);
    const expectedHistory = Array.from(
      { length: 100 },
      (_, index) => `Alice: message-${index}`,
    ).join("\n");
    expect(first.message.content).toBe(
      `[Earlier chat messages - for context]\n${expectedHistory}\n\n[Current message - respond to this]\nfirst-request`,
    );
    expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
    await promote(first);
    const second = await stage("second-request", await observe("second-request"));
    expect(second.message.content).toBe(
      "[Earlier chat messages - for context]\nAlice: arrived-after-request\n\n[Current message - respond to this]\nsecond-request",
    );
  });

  it("reserves an earlier buffered addressed source from another sender's capture", async () => {
    const alice = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "alice-buffered",
      message: { text: "Alice's addressed request", sender: { id: "alice" } },
      isRequest: true,
    });
    const bob = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "bob-immediate",
      message: { text: "Bob's addressed request", sender: { id: "bob" } },
      isRequest: true,
    });
    const first = await stage("bob-immediate", bob);
    expect(first.message.content).not.toContain("Alice's addressed request");
    await promote(first);
    const delayed = await stage("alice-buffered", alice);
    await promote(delayed);
    const events = await loadTranscriptEvents(sessionScope());
    expect(events.filter((event) => event.type === "message")).toHaveLength(2);
    expect(JSON.stringify(events)).toContain("alice-buffered");
    expect(JSON.stringify(events)).toContain("bob-immediate");
  });

  it("redacts observation, quote and enriched media metadata before restart and consumption", async () => {
    const marker = "CONFIDENTIAL_CANARY";
    const secret = "sk-abcdef1234567890xyz";
    const config: OpenClawConfig = { logging: { redactPatterns: [marker] } };
    const recordSensitiveSource = () =>
      recordConversationObservationCore(
        { ...scope(), config },
        {
          conversationRef,
          sourceId: "sensitive-background",
          message: {
            text: `Visible text ${secret} ${marker}`,
            replyTo: { text: `Quoted text ${secret} ${marker}`, sender: { name: marker } },
          },
        },
      );
    const observed = await recordSensitiveSource();
    await enrichConversationObservationCore(
      observed,
      "sensitive-background",
      { media: [{ path: "/media/inbound/safe.png", fileName: `${secret} ${marker}.png` }] },
      { config },
    );
    const persistedBefore = JSON.stringify(
      database().db.prepare("SELECT message_json FROM conversation_history").all(),
    );
    expect(persistedBefore).not.toContain(secret);
    expect(persistedBefore).not.toContain(marker);
    closeOpenClawAgentDatabasesForTest();
    expect(await recordSensitiveSource()).toEqual(observed);
    expect(
      JSON.stringify(database().db.prepare("SELECT message_json FROM conversation_history").all()),
    ).toBe(persistedBefore);
    const request = await stage("redacted-request", await observe("redacted-request"));
    await promote(request);
    const persistedAfter = JSON.stringify({
      observations: database().db.prepare("SELECT message_json FROM conversation_history").all(),
      transcript: await loadTranscriptEvents(sessionScope()),
    });
    expect(persistedAfter).not.toContain(secret);
    expect(persistedAfter).not.toContain(marker);
    expect(persistedAfter).toContain("Visible text");
    expect(persistedAfter).toContain("Quoted text");
    expect(persistedAfter).toContain("/media/inbound/safe.png");
  });

  it("reserves passive buffered siblings with their addressed request before another sender runs", async () => {
    const addressed = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "alice-first",
      message: { text: "Alice first" },
      isRequest: true,
    });
    const continuation = await observe("alice-continuation", { text: "Alice continuation" });
    const capture = expectDefined(
      await combineConversationHistoryCapturesCore([undefined, addressed, continuation]),
      "combined Alice request",
    );
    const bob = await stage("bob", await observe("bob"));
    expect(bob.message.content).not.toContain("Alice");
    await promote(bob);
    const alice = await stage("alice", capture);
    await promote(alice);
    expect(
      database()
        .db.prepare(
          "SELECT source_id FROM conversation_history WHERE consumed_session_id = ? ORDER BY seq",
        )
        .all(sessionId),
    ).toEqual([
      { source_id: "alice-first" },
      { source_id: "alice-continuation" },
      { source_id: "bob" },
    ]);
  });

  it("admits a late addressed buffered sibling without reclaiming an earlier passive source", async () => {
    const photo = await observe("alice-passive-photo", { text: "Alice's initial photo" });
    const bob = await stage("bob", await observe("bob"));
    const bobPromotion = expectDefined(await promote(bob), "Bob's transcript promotion");
    const readPhotoReceipt = () =>
      database()
        .db.prepare(
          "SELECT assigned_input_id, consumed_session_id, submission_started, message_json FROM conversation_history WHERE source_id = ?",
        )
        .get("alice-passive-photo");
    const originalReceipt = expectDefined(readPhotoReceipt(), "consumed photo receipt");
    expect(originalReceipt).toMatchObject({ consumed_session_id: sessionId });
    const originalTranscript = await loadTranscriptEvents(sessionScope());
    expect(originalTranscript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", id: bobPromotion.messageId }),
      ]),
    );
    const addressed = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "alice-caption",
      message: { text: "Alice asks about both photos" },
      isRequest: true,
    });
    const combined = expectDefined(
      await combineConversationHistoryCapturesCore([photo, addressed]),
      "late addressed album",
    );
    const alice = await stage("alice-album", combined);
    expect(alice.message.content).toBe("alice-album");
    expect(
      database()
        .db.prepare("SELECT assigned_input_id FROM conversation_history WHERE source_id = ?")
        .get("alice-caption"),
    ).toEqual({ assigned_input_id: alice.inputId });
    await promote(alice);
    expect(readPhotoReceipt()).toEqual(originalReceipt);
    expect(await loadTranscriptEvents(sessionScope())).toEqual([
      ...originalTranscript,
      expect.objectContaining({ type: "message", id: alice.inputId }),
    ]);
    expect(
      database()
        .db.prepare("SELECT consumed_session_id FROM conversation_history WHERE source_id = ?")
        .get("alice-caption"),
    ).toEqual({ consumed_session_id: sessionId });
  });

  it("keeps unrelated session writes responsive while visibility awaits outside capture admission", async () => {
    await observe("background");
    const capture = await observe("request");
    const entered = createDeferredCore<void>();
    const release = createDeferredCore<void>();
    const admission = stage("request", {
      ...capture,
      includeMessage: async () => {
        entered.resolve();
        await release.promise;
        return true;
      },
    });
    await entered.promise;
    let written = false;
    const unrelated = upsertSessionEntryCore(
      { ...scope(), sessionKey: "agent:main:unrelated" },
      {
        sessionId: "unrelated-session",
        updatedAt: 2,
      },
    ).then(() => {
      written = true;
    });
    try {
      await vi.waitFor(() => expect(written).toBe(true));
    } finally {
      release.resolve();
      await Promise.all([admission, unrelated]);
    }
  });

  it("reuses a transcript receipt committed while visibility waits without invoking the write hook", async () => {
    await observe("background");
    const capture = await observe("request");
    const entered = createDeferredCore<void>();
    const release = createDeferredCore<void>();
    const prepare = vi.fn((message: PersistedUserTurnMessage) => message);
    const admission = stage(
      "request",
      {
        ...capture,
        includeMessage: async () => {
          entered.resolve();
          await release.promise;
          return true;
        },
      },
      prepare,
    );
    await entered.promise;
    try {
      await appendTranscriptMessage(sessionScope(), { message: input("request") });
    } finally {
      release.resolve();
    }
    const receipt = await admission;
    expect(prepare).not.toHaveBeenCalled();
    expect(receipt.message).toEqual(input("request"));
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
    expect(
      (await loadTranscriptEvents(sessionScope())).filter((event) => event.type === "message"),
    ).toHaveLength(1);
  });

  it("rejects escaped multi-message backlog before visiting the complete backlog", async () => {
    const messages = 12;
    const text = '"'.repeat(Math.floor(MAX_PAYLOAD_BYTES / 8));
    for (let index = 0; index < messages; index += 1) {
      await observe(`large-${index}`, { text });
    }
    const readBacklogReceipt = () => ({
      totals: expectDefined(
        database()
          .db.prepare(
            "SELECT count(*) AS source_count, sum(octet_length(message_json)) AS serialized_bytes FROM conversation_history WHERE conversation_ref = ? AND source_id != ?",
          )
          .get(conversationRef, "large-request"),
        "persisted backlog totals",
      ),
      sources: database()
        .db.prepare(
          "SELECT source_id, json_extract(message_json, '$.observationCustody.sourceFingerprint') AS fingerprint, assigned_input_id, consumed_session_id, submission_started FROM conversation_history WHERE conversation_ref = ? AND source_id != ? ORDER BY seq",
        )
        .all(conversationRef, "large-request"),
    });
    const originalBacklog = readBacklogReceipt();
    expect(originalBacklog.totals.source_count).toBe(messages);
    expect(originalBacklog.totals.serialized_bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    let visited = 0;
    await expect(
      stage("large-request", {
        ...(await observe("large-request")),
        includeMessage: async () => {
          visited += 1;
          return true;
        },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
    expect(visited).toBeLessThan(messages);
    closeOpenClawAgentDatabasesForTest();
    expect(readBacklogReceipt()).toEqual(originalBacklog);
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
  });

  it("awaits speaker visibility and assigns all current request sources only once", async () => {
    await observe("allowed", { text: "visible", senderRoles: ["reader"] });
    await observe("restricted", { text: "restricted", senderRoles: ["private"] });
    const firstSource = await observe("album-1");
    const secondSource = await observe("album-2");
    const first = await stage("album", {
      ...secondSource,
      requestSourceIds: [...firstSource.requestSourceIds, ...secondSource.requestSourceIds],
      includeMessage: async (message) => message.senderRoles?.includes("reader") === true,
    });
    expect(first.message.content).toBe(
      "[Earlier chat messages - for context]\nvisible\n\n[Current message - respond to this]\nalbum",
    );
    await promote(first);
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toBe(
      "[Earlier chat messages - for context]\nrestricted\n\n[Current message - respond to this]\nnext",
    );
  });

  it("rechecks admission after asynchronous visibility before invoking the write hook", async () => {
    await observe("background");
    const capture = await observe("request");
    const controller = new AbortController();
    let prepared = false;
    await expect(
      stageSessionPendingInput(sessionScope(), {
        runId: "request",
        message: input("request"),
        conversationHistory: {
          ...capture,
          includeMessage: async () => {
            controller.abort();
            return true;
          },
        },
        assertCurrent: () => controller.signal.throwIfAborted(),
        prepareMessageAfterIdempotencyCheck: (message) => {
          prepared = true;
          return message;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(prepared).toBe(false);
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
    const recovered = await stage("next", await observe("next"));
    expect(recovered.message.content).toContain("Alice: background");
    expect(recovered.message.content).toContain("Alice: request");
  });

  it("preserves a native reply to a nonadjacent background message", async () => {
    await observe("first", {
      text: "Release today?",
      sender: { name: "Alice" },
      transport: { messageId: "10" },
    });
    await observe("second", {
      text: "Deploy tomorrow?",
      sender: { name: "Bob" },
      transport: { messageId: "11" },
    });
    await observe("answer", {
      text: "Yes.",
      sender: { name: "Carol" },
      transport: { messageId: "12", replyToId: "10" },
    });
    const captured = await stage("summarize", await observe("summarize"));
    expect(captured.message.content).toContain(
      "[message 10] Alice: Release today?\n[message 11] Bob: Deploy tomorrow?\n[message 12; reply to 10] Carol: Yes.",
    );
  });

  it("retains attachment references and timestamps across restart without injecting background images", async () => {
    const capture = await observe("photo", {
      text: "Which colour?",
      sender: { name: "Alice" },
      timestamp: 1_700_000_000_000,
    });
    const photo = {
      path: "/media/inbound/kitchen.png",
      contentType: "image/png",
      fileName: "kitchen.png",
    };
    await enrichConversationObservationCore(capture, "photo", { media: [photo] });
    closeOpenClawAgentDatabasesForTest();
    await enrichConversationObservationCore(capture, "photo", {
      media: [{ path: "/retry/copy.png" }],
    });
    const request = await stage("suggest a colour", await observe("request"));
    expect(request.message.content).toContain("[2023-11-14T22:13:20.000Z] Alice: Which colour?");
    expect(request.message.content).toContain("reference: /media/inbound/kitchen.png");
    expect(readPersistedMediaFacts(request.message)).toMatchObject([
      { ...photo, hydrationSuppressed: true, contextOnly: true },
    ]);
    await promote(request);
    await enrichConversationObservationCore(capture, "photo", {
      media: [{ path: "/late/replacement.png" }],
    });
    const events = await loadTranscriptEvents(sessionScope());
    expect(JSON.stringify(events)).toContain("kitchen.png");
    expect(JSON.stringify(events)).not.toContain("replacement.png");
  });

  it("preserves unseen reply targets while applying quote visibility independently", async () => {
    const quote = {
      text: "The departure is at 08:15",
      sender: { id: "private", name: "Bob" },
      messageId: "older",
    };
    await observe("reply", { text: "I'll be there", sender: { name: "Alice" }, replyTo: quote });
    const filtered = await stage("first", {
      ...(await observe("first")),
      includeMessage: async (_message, kind) => kind !== "quote",
    });
    expect(filtered.message.content).toContain("I'll be there");
    expect(filtered.message.content).not.toContain("08:15");
    filtered.finish("cancelled");
    const visible = await stage("second", await observe("second"));
    expect(visible.message.content).toContain(
      'Reply target older from Bob: "The departure is at 08:15"',
    );
  });

  it("resets only the captured conversation boundary and cannot resurrect a late download", async () => {
    const background = await observe("before-reset");
    await observe("other-room", { text: "Other room" }, "conv_other");
    const reset = await observe("reset");
    await observe("after-reset");
    runOpenClawAgentWriteTransaction(
      (db) => resetConversationHistory(db, reset),
      toDatabaseOptions(resolveSqliteReadScope(scope())),
    );
    await enrichConversationObservationCore(background, "before-reset", {
      media: [{ path: "/late.png" }],
    });
    const request = await stage("reset", reset);
    expect(request.message.content).toBe("reset");
    await promote(request);
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toContain("after-reset");
    expect(next.message.content).not.toContain("before-reset");
    expect(next.message.content).not.toContain("late.png");
    const other = await stage(
      "other-request",
      await observe("other-request", undefined, "conv_other"),
    );
    expect(other.message.content).toContain("Other room");
  });

  it("keeps a cleared passive source retired when its durable ingress event is replayed", async () => {
    const source = { text: "spooled before reset", media: [{ path: "/before-reset.png" }] };
    const old = await observe("spooled-source", source);
    const reset = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "reset",
      message: { text: "/new" },
      isRequest: true,
    });
    runOpenClawAgentWriteTransaction(
      (db) => resetConversationHistory(db, reset),
      toDatabaseOptions(resolveSqliteReadScope(scope())),
    );
    await promote(await stage("reset", reset));
    const replay = await observe("spooled-source", source);
    expect(replay.throughSequence).toBe(old.throughSequence);
    const retained = database()
      .db.prepare("SELECT message_json FROM conversation_history WHERE source_id = ?")
      .get("spooled-source");
    expect(JSON.stringify(retained)).not.toContain("spooled before reset");
    expect(JSON.stringify(retained)).not.toContain("/before-reset.png");
    const fresh = await stage("fresh", await observe("fresh"));
    expect(fresh.message.content).toBe("fresh");
    await expect(stage("spooled-source", replay)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      userMessage:
        "This request was cleared by a conversation reset. Send a new message to continue.",
    });
  });

  it("refuses live reset but retires inactive uncertain history without replay or receipt loss", async () => {
    await observe("background");
    const activeCapture = await observe("active");
    const pending = await stage("active", activeCapture);
    const reset = await recordConversationObservationCore(scope(), {
      conversationRef,
      sourceId: "reset",
      message: { text: "/new" },
      isRequest: true,
    });
    const resetHistory = () =>
      runOpenClawAgentWriteTransaction(
        (db) => resetConversationHistory(db, reset),
        toDatabaseOptions(resolveSqliteReadScope(scope())),
      );
    expect(resetHistory).toThrow("unfinished submission");
    pending.beginSubmission();
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const beforeReset = await stage("before-reset", await observe("before-reset"));
    expect(beforeReset.message.content).not.toContain("background");
    beforeReset.finish("cancelled");
    expect(resetHistory).not.toThrow();
    closeOpenClawAgentDatabasesForTest();
    expect(listSessionPendingInputs(sessionScope()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.inputId, state: "cancelled" }),
      ]),
    );
    expect(
      database()
        .db.prepare(
          "SELECT source_id, assigned_input_id, submission_started, json_extract(message_json, '$.text') AS source_text FROM conversation_history WHERE assigned_input_id = ? ORDER BY seq",
        )
        .all(pending.inputId),
    ).toEqual([
      {
        source_id: "background",
        assigned_input_id: pending.inputId,
        submission_started: 1,
        source_text: "background",
      },
      {
        source_id: "active",
        assigned_input_id: pending.inputId,
        submission_started: 1,
        source_text: "active",
      },
    ]);
    expect(
      database()
        .db.prepare(
          "SELECT state, json_extract(message_json, '$.content') AS message_content FROM session_pending_inputs WHERE input_id = ?",
        )
        .get(pending.inputId),
    ).toEqual({
      state: "cancelled",
      message_content:
        "[Earlier chat messages - for context]\nAlice: background\n\n[Current message - respond to this]\nactive",
    });
    await expect(stage("active", activeCapture)).rejects.toThrow("cleared by a conversation reset");
    const fresh = await stage("fresh", await observe("fresh"));
    expect(fresh.message.content).not.toContain("background");
    expect(fresh.message.content).not.toContain("Alice: active");
  });

  it("rejects an oversized backlog without taking custody and permits a fresh request after reset", async () => {
    await observe("large", { text: "x".repeat(MAX_PAYLOAD_BYTES) });
    const capture = await observe("request");
    await expect(stage("request", capture)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      userMessage: expect.stringContaining(
        "Nothing was sent. Use /new to start fresh without unread conversation; in a group, send it as a reply to this message.",
      ),
    });
    expect(listSessionPendingInputs(sessionScope()).total).toBe(0);
    expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
    const reset = await observe("reset");
    runOpenClawAgentWriteTransaction(
      (db) => resetConversationHistory(db, reset),
      toDatabaseOptions(resolveSqliteReadScope(scope())),
    );
    expect((await stage("reset", reset)).message.content).toBe("reset");
  });

  it("isolates logical agents in one physical store and rejects a changed capture owner", async () => {
    const storePath = path.join(fixture.sessionsDir(), "shared.sqlite");
    const agents = [];
    for (const agentId of ["main", "ops"]) {
      const agentScope = {
        agentId,
        storePath,
        sessionKey: `agent:${agentId}:shared`,
        sessionId: `${agentId}-shared-session`,
      };
      await upsertSessionEntryCore(agentScope, { sessionId: agentScope.sessionId, updatedAt: 1 });
      await recordConversationObservationCore(agentScope, {
        conversationRef,
        sourceId: "background",
        message: { text: "shared chat" },
      });
      const capture = await recordConversationObservationCore(agentScope, {
        conversationRef,
        sourceId: "request",
        message: { text: "request" },
      });
      agents.push({ scope: agentScope, capture });
    }
    const main = expectDefined(agents[0], "main agent fixture");
    const ops = expectDefined(agents[1], "ops agent fixture");
    expect(main.capture.owner.databasePath).toBe(ops.capture.owner.databasePath);
    for (const target of [ops.scope, sessionScope()]) {
      await expect(
        stageSessionPendingInput(target, {
          runId: "wrong-owner",
          message: input("wrong-owner"),
          conversationHistory: main.capture,
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("observation owner changed");
    }
    for (const agent of agents) {
      const receipt = await stageSessionPendingInput(agent.scope, {
        runId: "request",
        message: input("request"),
        conversationHistory: agent.capture,
        assertCurrent: () => {},
      });
      if (!receipt) {
        throw new Error("Shared-store request was not admitted");
      }
      receipts.push(receipt);
      expect(receipt.message.content).toContain("shared chat");
      await receipt.run(() => appendTranscriptMessage(agent.scope, { message: receipt.message }));
    }
  });

  it("releases cancelled context without replaying that request and preserves current interrupted custody", async () => {
    await observe("background");
    const cancelled = await stage("cancelled", await observe("cancelled"));
    cancelled.finish("cancelled");
    const next = await stage("next", await observe("next"));
    expect(next.message.content).toContain("Alice: background\nAlice: cancelled");
    next.finish("interrupted");
    const latest = await stage("latest", await observe("latest"));
    expect(latest.message.content).toBe("latest");
  });

  it("transfers abandoned pre-restart context to a fresh tag and rejects replay of the old request", async () => {
    await observe("background");
    const oldCapture = await observe("old-request");
    const old = await stage("old-request", oldCapture);
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const fresh = await stage("fresh-request", await observe("fresh-request"));
    expect(fresh.message.content).toContain("Alice: background\nAlice: old-request");
    expect(listSessionPendingInputs(sessionScope()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: old.inputId, state: "cancelled" })]),
    );
    await expect(stage("old-request", oldCapture)).rejects.toThrow("ownership ended");
    await promote(fresh);
    const last = await stage("last-request", await observe("last-request"));
    expect(last.message.content).toBe("last-request");
  });

  it.each([false, true])(
    "replays an unsent native request from its saved source payload (restart: %s)",
    async (restart) => {
      await observe("background");
      const capture = await observe("request");
      const hookInputs: PersistedUserTurnMessage["content"][] = [];
      const prepare = (message: PersistedUserTurnMessage): PersistedUserTurnMessage => {
        hookInputs.push(message.content);
        return { ...message, content: "approved $current-request" };
      };
      const original = await stage("request", capture, prepare);
      expect(hookInputs).toEqual(["request"]);
      expect(original.message["__openclaw"]?.observedInput).toEqual({
        context: "Alice: background",
        request: "approved $current-request",
      });
      expect(original.message.content).toBe(
        "[Earlier chat messages - for context]\nAlice: background\n\n[Current message - respond to this]\napproved $current-request",
      );
      original.finish("interrupted");
      if (restart) {
        rotateAgentEventLifecycleGeneration();
      }
      closeOpenClawAgentDatabasesForTest();
      const replay = await stage("request", capture, prepare);
      expect(replay.inputId).toBe(original.inputId);
      expect(replay.message).toEqual(original.message);
      expect(hookInputs).toEqual(["request"]);
      expect(
        replay.run(() => claimSessionPendingInputDedupeRecovery(sessionScope(), "request")),
      ).toBe(true);
      await promote(replay);
      expect(JSON.stringify(await loadTranscriptEvents(sessionScope()))).toContain(
        "Alice: background",
      );
      expect(JSON.stringify(await loadTranscriptEvents(sessionScope()))).toContain(
        "approved $current-request",
      );
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
    },
  );

  it.each([1, null])(
    "keeps uncertain history unavailable after pending-row deletion (submission fact: %s)",
    async (submissionStarted) => {
      await observe("background");
      const original = await stage("request", await observe("request"));
      original.beginSubmission();
      original.finish("interrupted");
      const db = database().db;
      if (submissionStarted === null) {
        db.prepare(
          "UPDATE conversation_history SET submission_started = NULL WHERE assigned_input_id = ?",
        ).run(original.inputId);
      }
      db.prepare("DELETE FROM session_pending_inputs WHERE input_id = ?").run(original.inputId);
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
      expect(
        db
          .prepare(
            "SELECT assigned_input_id, submission_started FROM conversation_history WHERE source_id = 'background'",
          )
          .get(),
      ).toEqual({
        assigned_input_id: null,
        submission_started: submissionStarted,
      });
    },
  );

  it.each(["cancelled", "interrupted"] as const)(
    "preserves uncertain submission through %s and restart",
    async (disposition) => {
      await observe("background");
      const capture = await observe("request");
      const original = await stage("request", capture);
      const attempt = original.beginSubmission();
      original.finish(disposition);
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      const next = await stage("next", await observe("next"));
      expect(next.message.content).toBe("next");
      await expect(stage("request", capture)).rejects.toThrow(
        disposition === "cancelled" ? "ownership ended" : "delivery is uncertain",
      );
      expect(() => attempt.rejectSubmission()).toThrow("ownership ended");
      expect(
        database()
          .db.prepare(
            "SELECT source_id, assigned_input_id, submission_started FROM conversation_history WHERE source_id IN ('background', 'request') ORDER BY seq",
          )
          .all(),
      ).toEqual([
        { source_id: "background", assigned_input_id: original.inputId, submission_started: 1 },
        { source_id: "request", assigned_input_id: original.inputId, submission_started: 1 },
      ]);
    },
  );

  it("retries definitive rejection without allowing an earlier attempt to reopen later submission", async () => {
    const capture = await observe("request");
    const original = await stage("request", capture);
    const rejected = original.beginSubmission();
    rejected.rejectSubmission();
    const active = original.beginSubmission();
    expect(() => rejected.rejectSubmission()).toThrow("closed submission attempt");
    active.rejectSubmission();
    original.finish("interrupted");
    rotateAgentEventLifecycleGeneration();
    const replay = await stage("request", capture);
    expect(replay.inputId).toBe(original.inputId);
    await promote(replay);
  });

  it("records provider submission once when a staged recorder has no local transcript adoption", async () => {
    await observe("background");
    const capture = await observe("request");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "request", idempotencyKey: "request" },
      target: { ...sessionScope(), sessionEntry: undefined },
    });
    try {
      expect(
        await recorder.stageApproved?.({
          runId: "request",
          conversationHistory: capture,
          assertCurrent: () => {},
        }),
      ).toBe(true);
      recorder.markSentToProvider?.();
      recorder.markSentToProvider?.();
      expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
      recorder.finishPendingInput?.("interrupted");
      rotateAgentEventLifecycleGeneration();
      closeOpenClawAgentDatabasesForTest();
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
      await expect(stage("request", capture)).rejects.toThrow("delivery is uncertain");
    } finally {
      recorder.finishPendingInput?.("interrupted");
    }
  });

  it.each(["capture", "adoption"] as const)(
    "rolls back %s with source custody intact",
    async (phase) => {
      await observe("background");
      const capture = await observe("request");
      const db = database().db;
      let receipt = phase === "adoption" ? await stage("request", capture) : undefined;
      const column = phase === "capture" ? "assigned_input_id" : "consumed_session_id";
      db.exec(
        `CREATE TEMP TRIGGER reject_history BEFORE UPDATE OF ${column} ON conversation_history BEGIN SELECT RAISE(ABORT, 'history write failed'); END`,
      );
      try {
        await expect(receipt ? promote(receipt) : stage("request", capture)).rejects.toThrow(
          "history write failed",
        );
      } finally {
        db.exec("DROP TRIGGER reject_history");
      }
      expect(await loadTranscriptEvents(sessionScope())).toEqual([]);
      expect(listSessionPendingInputs(sessionScope()).total).toBe(phase === "capture" ? 0 : 1);
      receipt ??= await stage("request", capture);
      expect(receipt.message.content).toContain("Alice: background");
      await promote(receipt);
      expect((await stage("next", await observe("next"))).message.content).toBe("next");
    },
  );

  it.each([false, true])(
    "retains consumed originals exactly while their transcript remains (archive: %s)",
    async (archiveTranscript) => {
      await observe("background");
      await promote(await stage("request", await observe("request")));
      await observe("unread");
      await deleteSessionEntryLifecycle({
        archiveTranscript,
        deleteTranscriptWithoutArchive: !archiveTranscript,
        storePath: fixture.storePath(),
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(
        database()
          .db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
          .get(sessionId),
      ).toBeUndefined();
      const retained = database()
        .db.prepare("SELECT source_id FROM conversation_history ORDER BY seq")
        .all();
      expect(retained).toEqual(
        (archiveTranscript ? ["background", "request", "unread"] : ["unread"]).map((source_id) => ({
          source_id,
        })),
      );
      await upsertSessionEntryCore(sessionScope(), { sessionId, updatedAt: 2 });
      expect((await stage("after-reset", await observe("after-reset"))).message.content).toContain(
        "Alice: unread",
      );
    },
  );

  it.each(["window", "archive"] as const)(
    "reconciles history after an older writer deletes its %s owner",
    async (owner) => {
      await observe("orphan-background");
      await promote(await stage("orphan-request", await observe("orphan-request")));
      if (owner === "archive") {
        await deleteSessionEntryLifecycle({
          archiveTranscript: true,
          storePath: fixture.storePath(),
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
      }
      const retainedScope = {
        ...scope(),
        sessionKey: "agent:main:retained",
        sessionId: "retained-session",
      };
      await upsertSessionEntryCore(retainedScope, {
        sessionId: retainedScope.sessionId,
        updatedAt: 2,
      });
      let pending: SessionPendingInputReceipt | undefined;
      for (const runId of ["retained-consumed", "retained-pending"]) {
        const receipt = await stageSessionPendingInput(retainedScope, {
          runId,
          message: input(runId),
          conversationHistory: await observe(runId, { text: runId }, "conv_retained"),
          assertCurrent: () => {},
        });
        if (!receipt) {
          throw new Error("Retained input was not admitted");
        }
        receipts.push(receipt);
        if (runId === "retained-consumed") {
          await receipt.run(() =>
            appendTranscriptMessage(retainedScope, { message: receipt.message }),
          );
        } else {
          pending = receipt;
          pending.finish("interrupted");
        }
      }
      await observe("unread");
      const filename = database().path;
      closeOpenClawAgentDatabasesForTest();
      const previous = new DatabaseSync(filename);
      try {
        previous.exec("PRAGMA foreign_keys = ON");
        // An older writer knows transcript owners but has no conversation-history deletion hook.
        previous.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sessionKey);
        previous
          .prepare("DELETE FROM session_transcript_archives WHERE session_id = ?")
          .run(sessionId);
      } finally {
        previous.close();
      }
      await observe("after-upgrade");
      expect(
        database()
          .db.prepare(
            "SELECT source_id, assigned_input_id, consumed_session_id FROM conversation_history ORDER BY seq",
          )
          .all(),
      ).toEqual([
        {
          source_id: "retained-consumed",
          assigned_input_id: null,
          consumed_session_id: retainedScope.sessionId,
        },
        {
          source_id: "retained-pending",
          assigned_input_id: pending?.inputId,
          consumed_session_id: null,
        },
        { source_id: "unread", assigned_input_id: null, consumed_session_id: null },
        { source_id: "after-upgrade", assigned_input_id: null, consumed_session_id: null },
      ]);
    },
  );
});
