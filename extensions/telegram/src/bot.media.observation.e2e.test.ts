import { expectDefined } from "@openclaw/normalization-core";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { setNextSavedMediaPath, telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandlerWithOptions,
  flushActiveScheduledTimersForDelay,
  holdTelegramMediaTimeouts,
  mockTelegramPngDownload,
} from "./bot.media.test-utils.js";

describe("telegram media observation", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it.each(["first", "unmentioned", "later"] as const)(
    "preserves album ownership when another sender tags before flush (addressed caption: %s)",
    async (captionPosition) => {
      const addressed = captionPosition !== "unmentioned";
      const hasLaterCaption = captionPosition === "later";
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = () => ({
        channels: {
          telegram: { dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" },
        },
      });
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const { handler, replySpy, runtimeError } = await createBotHandlerWithOptions({});
      const originalReplyImplementation = expectDefined(
        replySpy.getMockImplementation(),
        "original media reply implementation",
      );
      const submitted: Array<{
        request: string;
        sourceIds: string[];
        content: unknown;
        mediaPaths: Array<string | undefined>;
      }> = [];
      const recorders: ReturnType<typeof createRecorder>[] = [];
      const albumParticipants: TelegramSpooledReplayDeferredParticipant[] = [];
      replySpy.mockImplementation(async (ctx: MsgContext) => {
        const capture = ctx.ConversationHistory;
        if (!capture || !ctx.SessionKey || !ctx.MessageSid || typeof ctx.RawBody !== "string") {
          throw new Error("Expected an addressed album request with its observation capture");
        }
        const target = {
          agentId: capture.owner.agentId,
          storePath: capture.owner.databasePath,
          sessionKey: ctx.SessionKey,
          sessionId: "album-reservation-session",
          sessionEntry: undefined,
        };
        await upsertSessionEntry({
          ...target,
          entry: { sessionId: target.sessionId, updatedAt: 1 },
        });
        const recorder = createRecorder({
          input: { text: ctx.RawBody, idempotencyKey: ctx.MessageSid },
          target,
          conversationHistory: capture,
        });
        recorders.push(recorder);
        await recorder.stageApproved!({ runId: ctx.MessageSid, assertCurrent: () => {} });
        submitted.push({
          request: ctx.RawBody,
          sourceIds: [...capture.requestSourceIds],
          content: recorder.message?.content,
          mediaPaths: ctx.media?.map((media) => media.path) ?? [],
        });
      });
      const caption = `${captionPosition === "first" ? "@openclaw_bot " : ""}Alice's album`;
      const laterCaption = "@openclaw_bot Alice's later album request";
      const bobRequest = "@openclaw_bot Bob's request";
      const chat = { id: -10044, type: "supergroup" as const, title: "Album room" };
      const bobMessage = {
        message: {
          chat,
          from: { id: 888, is_bot: false, first_name: "Bob" },
          message_id: 403,
          date: 1736380802,
          text: bobRequest,
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      };
      const savedPaths = [
        "/tmp/media/inbound/album-reservation-1.png",
        "/tmp/media/inbound/album-reservation-2.png",
      ];
      const fetchSpy = mockTelegramPngDownload();
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        for (const [index, savedPath] of savedPaths.entries()) {
          if (index === 1 && hasLaterCaption) {
            expect(submitted).toEqual([]);
            await handler(bobMessage);
            expect(submitted.map((input) => input.request)).toEqual([bobRequest]);
          }
          setNextSavedMediaPath({ path: savedPath, contentType: "image/png" });
          const update = { update_id: 1401 + index };
          const receipt = await runWithTelegramSpooledReplayUpdate(update, () =>
            handler({
              update,
              message: {
                chat,
                from: { id: 777, is_bot: false, first_name: "Alice" },
                message_id: 401 + index,
                date: 1736380800 + index,
                media_group_id: "reserved-album",
                photo: [{ file_id: `reserved-photo-${index}` }],
                ...(index === 0
                  ? {
                      caption,
                      ...(captionPosition === "first"
                        ? { caption_entities: [{ type: "mention", offset: 0, length: 13 }] }
                        : {}),
                    }
                  : hasLaterCaption
                    ? {
                        caption: laterCaption,
                        caption_entities: [{ type: "mention", offset: 0, length: 13 }],
                      }
                    : {}),
              },
              me: { username: "openclaw_bot" },
              getFile: async () => ({ file_path: `photos/reserved-photo-${index}.png` }),
            }),
          );
          if (!receipt.deferredWork) {
            throw new Error("Expected album receipt to defer until its buffer flushes");
          }
          albumParticipants.push(receipt.deferredWork);
        }
        if (!hasLaterCaption) {
          expect(submitted).toEqual([]);
          await handler(bobMessage);
        }
        expect(submitted.map((input) => input.request)).toEqual([bobRequest]);
        if (captionPosition === "first") {
          expect(JSON.stringify(submitted[0].content)).not.toContain("Alice's album");
        } else {
          expect(JSON.stringify(submitted[0].content)).toContain("Alice's album");
        }
        await flushActiveScheduledTimersForDelay({
          setTimeoutSpy,
          clearTimeoutSpy,
          delayMs: TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
          expectedCount: 1,
        });
        await Promise.all(albumParticipants.map((participant) => participant.task));
        expect(submitted).toHaveLength(addressed ? 2 : 1);
        expect(submitted.map((input) => input.sourceIds)).toEqual(
          addressed ? [["403"], ["401", "402"]] : [["403"]],
        );
        if (addressed) {
          expect(submitted[1]).toMatchObject({
            request: hasLaterCaption ? `${caption}\n${laterCaption}` : caption,
            mediaPaths: savedPaths,
          });
        }
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        replySpy.mockImplementation(originalReplyImplementation);
        for (const recorder of recorders) {
          recorder.finishPendingInput?.("cancelled");
        }
        for (const participant of albumParticipants) {
          participant.settle({ kind: "skipped" });
        }
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        fetchSpy.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});
