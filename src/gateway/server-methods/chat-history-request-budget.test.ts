import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { reconcileSessionTranscriptIndexes } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";

function createHistoryRequest(
  sessionKey: string,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  const context = createDirectChatContext();
  return async (params: Record<string, unknown>) => {
    let result: unknown;
    await expectDefined(
      chatHistoryHandlers[method],
      "history handler",
    )({
      params: { sessionKey, limit: 80, ...params },
      context,
      req: { type: "req", id: "budgeted-history", method },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        expect(error).toBeUndefined();
        expect(ok).toBe(true);
        result = payload;
      },
    });
    return expectDefined(asOptionalRecord(result), "history response");
  };
}

async function writeHistoryMessages(messages: Record<string, unknown>[]) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:scan-budget",
    sessionId: "scan-budget",
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(
    scope,
    messages.map((message, index) => ({
      type: "message",
      id: `event-${index}`,
      parentId: index > 0 ? `event-${index - 1}` : null,
      timestamp: new Date(index + 1).toISOString(),
      message: { ...message, timestamp: index + 1 },
    })),
  );
  await reconcileSessionTranscriptIndexes({ agentId: scope.agentId });
  return scope;
}

describe("chat history request byte budgets", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns a small tail with a lossless back-scroll cursor",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:budgeted-history",
          sessionId: "budgeted-history",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const messages = Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content:
            index % 4 === 1
              ? [
                  { type: "toolcall", id: `call-${index}`, name: "Read", arguments: {} },
                  {
                    type: "tool_result",
                    tool_use_id: `call-${index}`,
                    content: `record-${index}: ${"x".repeat(3_000)}`,
                  },
                ]
              : [{ type: "text", text: `record-${index}: ${"x".repeat(3_000)}` }],
        }));
        for (const message of messages) {
          await appendTranscriptMessage(scope, { message });
        }
        const request = createHistoryRequest(scope.sessionKey, method);

        const tail = await request({ maxBytes: 8 * 1024 });
        expect(Buffer.byteLength(JSON.stringify(tail.messages))).toBeLessThanOrEqual(8 * 1024);
        expect(tail.hasMore).toBe(true);
        expect(tail.nextOffset).toBeGreaterThan(0);
        expect(JSON.stringify(tail.messages)).toContain("record-11:");
        const older = await request({ offset: tail.nextOffset });
        expect(older.hasMore).toBe(false);
        const restored = [...(older.messages as unknown[]), ...(tail.messages as unknown[])];
        expect(restored).toHaveLength(messages.length);
        for (const [index, message] of restored.entries()) {
          expect(JSON.stringify(message)).toContain(`record-${index}:`);
        }

        const longText = "Readable message beyond the soft page budget: " + "z".repeat(70_000);
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: [{ type: "text", text: longText }] },
        });
        expect(await request({ cursor: tail.deltaCursor, maxBytes: 8 * 1024 })).toEqual({
          kind: "reset",
        });
        const single = await request({ maxBytes: 64 * 1024, maxChars: 100_000 });
        expect(single.messages).toHaveLength(1);
        expect(JSON.stringify(single.messages)).toContain(longText);
        expect(single.hasMore).toBe(true);
      });
    },
  );

  it("fills a large-tool tail without serializing oversized raw history arrays", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await writeHistoryMessages(
        Array.from({ length: 120 }, (_, index) => ({
          role: "toolResult",
          toolName: "read",
          toolCallId: `call-${index}`,
          isError: false,
          content: [{ type: "text", text: "x".repeat(128 * 1024) }],
        })),
      );
      const request = createHistoryRequest(scope.sessionKey);
      const stringify = JSON.stringify;
      let largestSerializedArray = 0;
      const serialization = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
        const result = stringify(...args);
        if (Array.isArray(args[0]) && typeof result === "string") {
          largestSerializedArray = Math.max(largestSerializedArray, Buffer.byteLength(result));
        }
        return result;
      });
      let response;
      try {
        response = await request({ maxBytes: 256 * 1024 });
      } finally {
        serialization.mockRestore();
      }
      expect(response.messages).toHaveLength(80);
      expect(response).toMatchObject({ hasMore: true, nextOffset: 80 });
      expect(largestSerializedArray).toBeLessThanOrEqual(256 * 1024);
    });
  });

  it.each(["plain", "unicode"])(
    "preserves the exact sparse-scan byte cutoff for %s rows",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = await writeHistoryMessages(
          Array.from({ length: 600 }, () => ({
            role: "assistant",
            content: "NO_REPLY",
            providerReplay: { text: kind === "unicode" ? '🦞漢字\n"\\\ud800'.repeat(16) : "plain" },
          })),
        );
        const first = await readSessionMessagesPageWithStatsAsync(scope, {
          offset: 9,
          maxMessages: 72,
        });
        const second = await readSessionMessagesPageWithStatsAsync(scope, {
          offset: 80,
          maxMessages: 201,
        });
        const cutoff =
          Buffer.byteLength(JSON.stringify(first.messages)) +
          Buffer.byteLength(JSON.stringify(second.messages));
        const request = createHistoryRequest(scope.sessionKey);
        const stopped = await request({ limit: 3, maxBytes: cutoff });
        expect(stopped).toMatchObject({ messages: [], hasMore: true, nextOffset: 280 });
        const continued = await request({ limit: 3, maxBytes: cutoff + 1 });
        expect(continued).toMatchObject({ messages: [], hasMore: false });
        expect(continued.nextOffset).toBeUndefined();
      });
    },
  );
});
