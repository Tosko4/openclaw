// Telegram tests cover bot.media.stickers and fragments plugin behavior.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRemoteMediaBufferSpy, telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandlerWithOptions,
  holdTelegramMediaTimeouts,
  describeStickerImageSpy,
  getCachedStickerSpy,
} from "./bot.media.test-utils.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";

function resolveScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const clearedHandles = new Set(
    (clearTimeoutSpy.mock.calls as Array<Parameters<typeof clearTimeout>>).map(
      ([handle]) => handle,
    ),
  );
  const timerCalls = setTimeoutSpy.mock.calls as Array<Parameters<typeof setTimeout>>;
  const timerCallIndex = timerCalls.findLastIndex(
    (call, index) =>
      call[1] === delayMs &&
      !clearedHandles.has(
        setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>,
      ),
  );
  const flushTimer =
    timerCallIndex >= 0
      ? (timerCalls[timerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (timerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[timerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

async function flushScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const flushTimer = resolveScheduledTimerForDelay(setTimeoutSpy, clearTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
}

type ScheduledTimer = {
  callback: () => unknown;
  handle: ReturnType<typeof setTimeout>;
};

function resolveActiveScheduledTimersForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
): ScheduledTimer[] {
  const clearedHandles = new Set(
    (clearTimeoutSpy.mock.calls as Array<Parameters<typeof clearTimeout>>).map(
      ([handle]) => handle,
    ),
  );
  return (setTimeoutSpy.mock.calls as Array<Parameters<typeof setTimeout>>).flatMap(
    (call, index) => {
      if (call[1] !== delayMs) {
        return [];
      }
      const handle = setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      if (clearedHandles.has(handle) || typeof call[0] !== "function") {
        return [];
      }
      return [{ callback: call[0] as () => unknown, handle }];
    },
  );
}

describe("telegram stickers", () => {
  // Parallel Testbox shards can make these media-path e2e tests slower than standalone local runs.
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;
  beforeEach(() => {
    cacheStickerSpy.mockClear();
    getCachedStickerSpy.mockClear();
    describeStickerImageSpy.mockClear();
    // Re-seed defaults so per-test overrides do not leak when using mockClear.
    getCachedStickerSpy.mockReturnValue(undefined);
    describeStickerImageSpy.mockReturnValue(undefined);
  });

  it(
    "refreshes cached sticker metadata on cache hit",
    async () => {
      const proxyFetch = vi.fn().mockResolvedValue(
        new Response(Buffer.from(new Uint8Array([0x52, 0x49, 0x46, 0x46])), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
      );

      getCachedStickerSpy.mockReturnValue({
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        emoji: "😴",
        setName: "OldSet",
        description: "Cached description",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });

      const media = await resolveMedia({
        maxBytes: 2 * 1024 * 1024,
        token: "tok",
        transport: {
          close: async () => {},
          fetch: proxyFetch as unknown as typeof fetch,
          sourceFetch: proxyFetch as unknown as typeof fetch,
        } satisfies TelegramTransport,
        ctx: {
          message: {
            message_id: 103,
            chat: { id: 1234, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            sticker: {
              file_id: "new_file_id",
              file_unique_id: "sticker_unique_456",
              type: "regular",
              width: 512,
              height: 512,
              is_animated: false,
              is_video: false,
              emoji: "🔥",
              set_name: "NewSet",
            },
            date: 1736380800,
          },
          getFile: async () => ({ file_path: "stickers/sticker.webp" }),
        } as TelegramContext,
      });

      const [cachedSticker] =
        (
          cacheStickerSpy.mock.calls as unknown as Array<
            [{ emoji?: string; fileId?: string; setName?: string }]
          >
        )[0] ?? [];
      expect(cachedSticker?.fileId).toBe("new_file_id");
      expect(cachedSticker?.emoji).toBe("🔥");
      expect(cachedSticker?.setName).toBe("NewSet");
      expect(media?.stickerMetadata?.fileId).toBe("new_file_id");
      expect(media?.stickerMetadata?.cachedDescription).toBe("Cached description");
      const [fetchUrl, fetchOptions] = proxyFetch.mock.calls.at(0) ?? [];
      expect(fetchUrl).toBe("https://api.telegram.org/file/bottok/stickers/sticker.webp");
      expect(fetchOptions?.redirect).toBe("manual");
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "rejects animated and video sticker downloads before fetching bytes",
    async () => {
      const proxyFetch = vi.fn();

      for (const scenario of [
        {
          messageId: 101,
          filePath: "stickers/animated.tgs",
          sticker: {
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: true,
            is_video: false,
            emoji: "😎",
            set_name: "AnimatedPack",
          },
        },
        {
          messageId: 102,
          filePath: "stickers/video.webm",
          sticker: {
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: true,
            emoji: "🎬",
            set_name: "VideoPack",
          },
        },
      ]) {
        proxyFetch.mockClear();
        const getFile = vi.fn(async () => ({ file_path: scenario.filePath }));

        const media = await resolveMedia({
          maxBytes: 2 * 1024 * 1024,
          token: "tok",
          transport: {
            close: async () => {},
            fetch: proxyFetch as unknown as typeof fetch,
            sourceFetch: proxyFetch as unknown as typeof fetch,
          } satisfies TelegramTransport,
          ctx: {
            message: {
              message_id: scenario.messageId,
              chat: { id: 1234, type: "private" },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              sticker: scenario.sticker,
              date: 1736380800,
            },
            getFile,
          } as unknown as TelegramContext,
        });

        expect(media).toBeNull();
        expect(getFile).not.toHaveBeenCalled();
        expect(proxyFetch).not.toHaveBeenCalled();
      }
    },
    STICKER_TEST_TIMEOUT_MS,
  );
});

describe("telegram local Bot API media", () => {
  it("reads a container-local file from its trusted host volume mount", async () => {
    const token = "123:test-token";
    const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-tg-local-")));
    const relativePath = path.join(token, "documents", "file_12.zip");
    try {
      await mkdir(path.dirname(path.join(tempRoot, relativePath)), { recursive: true });
      await writeFile(path.join(tempRoot, relativePath), "zip-data");

      const media = await resolveMedia({
        maxBytes: 1024,
        token,
        trustedLocalFileRoots: [tempRoot],
        ctx: {
          message: {
            message_id: 104,
            chat: { id: 1234, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            document: {
              file_id: "document_file_id",
              file_unique_id: "document_unique_id",
              file_name: "archive.zip",
              mime_type: "application/zip",
            },
            date: 1736380800,
          },
          getFile: async () => ({
            file_path: `/var/lib/telegram-bot-api/${token}/documents/file_12.zip`,
          }),
        } as TelegramContext,
      });

      expect(readRemoteMediaBufferSpy).not.toHaveBeenCalled();
      expect(media).toMatchObject({
        path: "/tmp/telegram-media",
        contentType: "application/zip",
        kind: "document",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  it.each([false, true])(
    "keeps a buffered tag reserved when another sender tags before it flushes (continuation: %s)",
    async (withContinuation) => {
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const { handler, replySpy, runtimeError } = await createBotHandlerWithOptions({});
      const originalReply = expectDefined(
        replySpy.getMockImplementation(),
        "Telegram reply fixture",
      );
      const submitted: Array<{ request: string; content: unknown }> = [];
      const recorders: ReturnType<typeof createRecorder>[] = [];
      replySpy.mockImplementation(async (ctx: MsgContext) => {
        const capture = ctx.ConversationHistory;
        if (!capture || !ctx.SessionKey || !ctx.MessageSid || typeof ctx.RawBody !== "string") {
          throw new Error("Expected an addressed Telegram request with its observation capture");
        }
        const target = {
          agentId: capture.owner.agentId,
          storePath: capture.owner.databasePath,
          sessionKey: ctx.SessionKey,
          sessionId: "buffered-tag-session",
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
        submitted.push({ request: ctx.RawBody, content: recorder.message?.content });
      });
      const firstText = `@openclaw_bot Alice's request ${"a".repeat(4000)}`;
      const continuation = " Alice's final instruction";
      const secondText = "@openclaw_bot Bob's request";
      const message = (messageId: number, senderId: number, text: string) => ({
        message: {
          chat: { id: -10042, type: "supergroup", title: "Friends" },
          from: { id: senderId, is_bot: false, first_name: String(senderId) },
          message_id: messageId,
          date: 1736380800 + messageId,
          text,
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      const timer = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.textFragmentGapMs);
      const clearTimer = vi.spyOn(globalThis, "clearTimeout");
      try {
        await handler(message(10, 777, firstText));
        if (withContinuation) {
          const fragment = message(11, 777, continuation);
          fragment.message.entities = [];
          await handler(fragment);
        }
        await handler(message(withContinuation ? 12 : 11, 888, secondText));
        expect(submitted.map((input) => input.request)).toEqual([secondText]);
        expect(JSON.stringify(submitted[0].content)).not.toContain("Alice's request");
        expect(JSON.stringify(submitted[0].content)).not.toContain("Alice's final instruction");
        await flushScheduledTimerForDelay(
          timer,
          clearTimer,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        );
        await vi.waitFor(() =>
          expect(submitted.map((input) => input.request)).toEqual([
            secondText,
            withContinuation ? firstText + continuation : firstText,
          ]),
        );
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        for (const recorder of recorders) {
          recorder.finishPendingInput?.("cancelled");
        }
        replySpy.mockImplementation(originalReply);
        timer.mockRestore();
        clearTimer.mockRestore();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "allows native tags in an open group when DM senders are restricted",
    async () => {
      telegramBotDepsForTest.getRuntimeConfig = () => ({
        channels: { telegram: { dmPolicy: "allowlist", allowFrom: ["999"], groupPolicy: "open" } },
      });
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      await handler({
        message: {
          chat: { id: -10043, type: "supergroup", title: "Open group" },
          from: { id: 777, is_bot: false, first_name: "Alice" },
          message_id: 20,
          date: 1736380800,
          text: "@openclaw_bot hello",
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      expect(replySpy).toHaveBeenCalledOnce();
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  const buildNearLimitMessage = (params: {
    messageId: number;
    prefix?: string;
    suffix?: string;
    entities?: Array<{ type: "bot_command"; offset: number; length: number }>;
  }) => {
    const text = `${params.prefix ?? ""}${"A".repeat(4050)}${params.suffix ?? ""}`;
    return {
      text,
      message: {
        chat: { id: 42, type: "private" as const },
        from: { id: 777, is_bot: false as const, first_name: "Ada" },
        message_id: params.messageId,
        date: 1736380800,
        text,
        ...(params.entities ? { entities: params.entities } : {}),
      },
    };
  };

  it.each([
    { label: "plain", prefix: "" },
    { label: "slash-prefixed non-command", prefix: "/not_a_command " },
  ])(
    "buffers $label near-limit text and processes sequential parts as one message",
    async ({ prefix }) => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const quote = "FRAGMENT_REPLY_QUOTE";
      const { text: part1, message: firstMessage } = buildNearLimitMessage({
        messageId: 10,
        prefix,
        suffix: ` ${quote}`,
      });
      const part2 = "B".repeat(50);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      try {
        await handler({
          message: firstMessage,
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 11,
            date: 1736380801,
            text: part2,
            reply_to_message: { ...firstMessage, reply_to_message: undefined },
            quote: { text: quote, position: part1.indexOf(quote) },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        expect(replySpy).not.toHaveBeenCalled();
        await flushScheduledTimerForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        );

        await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
        const payload = replySpy.mock.calls.at(0)?.[0] as { Body?: string; RawBody?: string };
        expect(payload.RawBody).toContain(part1.slice(0, 32));
        expect(payload.RawBody).toContain(part2.slice(0, 32));
        expect(payload.Body).toContain(`[1. Ada id:10]\n"${quote}"`);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "processes leading Telegram bot commands immediately without static registration",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const command = "/deploy@openclaw_bot";
      const { message } = buildNearLimitMessage({
        messageId: 20,
        prefix: `${command} `,
        entities: [{ type: "bot_command", offset: 0, length: command.length }],
      });

      await handler({
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps per-DM pairing store authorization when flushing text fragments",
    async () => {
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            direct: {
              "42": { dmPolicy: "pairing" },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      const readAllowFromStore = vi.mocked(telegramBotDepsForTest.readChannelAllowFromStore);
      const upsertPairingRequest = vi.mocked(telegramBotDepsForTest.upsertChannelPairingRequest);
      readAllowFromStore.mockReset();
      readAllowFromStore.mockResolvedValue(["777"]);
      upsertPairingRequest.mockClear();

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.textFragmentGapMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      try {
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 30,
            date: 1736380800,
            text: part1,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 31,
            date: 1736380801,
            text: part2,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await flushScheduledTimerForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        );

        await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
        expect(readAllowFromStore).toHaveBeenCalledWith("telegram", process.env, "default");
        expect(upsertPairingRequest).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
        readAllowFromStore.mockReset();
        readAllowFromStore.mockResolvedValue([]);
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "buffers different forum topic fragments independently",
    async () => {
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["777"],
            groupPolicy: "open",
            groups: {
              "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention: false },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.textFragmentGapMs);
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      try {
        await handler({
          message: {
            chat: { id: -10042, type: "supergroup", is_forum: true },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 120,
            message_thread_id: 101,
            is_topic_message: true,
            date: 1736380800,
            text: `@openclaw_bot topic-one ${"A".repeat(4050)}`,
            entities: [{ type: "mention", offset: 0, length: 13 }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: -10042, type: "supergroup", is_forum: true },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 121,
            message_thread_id: 202,
            is_topic_message: true,
            date: 1736380801,
            text: `@openclaw_bot topic-two ${"B".repeat(4050)}`,
            entities: [{ type: "mention", offset: 0, length: 13 }],
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        const timers = resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        );
        expect(timers).toHaveLength(2);
        for (const timer of timers) {
          clearTimeout(timer.handle);
          await timer.callback();
        }
        await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(2));
        const rawBodies = replySpy.mock.calls.map(
          (call) => (call[0] as { RawBody?: string }).RawBody,
        );
        expect(rawBodies).toEqual(
          expect.arrayContaining([
            expect.stringContaining("topic-one"),
            expect.stringContaining("topic-two"),
          ]),
        );
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        for (const timer of resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        )) {
          clearTimeout(timer.handle);
        }
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
