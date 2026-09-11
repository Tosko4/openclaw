import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createReasoningStreamContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliveredReply,
  loadSessionStore,
  mockCallArg,
  sendMessageTelegram,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

const emptyDispatchResult = {
  queuedFinal: false,
  counts: { block: 0, final: 0, tool: 0 },
};

const messageToolOnlyDispatchResult = {
  ...emptyDispatchResult,
  sourceReplyDeliveryMode: "message_tool_only" as const,
};

function mockTurn(
  run: (params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<void>,
  result: unknown = { queuedFinal: true },
) {
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
    await run(params);
    return result;
  });
}

describeTelegramDispatch("dispatchTelegramMessage reasoning delivery", () => {
  it("keeps shared durable reasoning payloads disabled when reasoning is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

    await dispatchWithContext({ context: createContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("opts shared dispatch into durable reasoning payload delivery when reasoning streams", async () => {
    setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

    await dispatchWithContext({ context: createReasoningStreamContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(true);
  });

  it("keeps shared durable reasoning payloads disabled in progress stream mode", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("suppresses typed reasoning-only finals without raw text fallback", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to the reasoning lane when reasoning streams", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "🧠 _hidden_",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("suppresses whitespace-form internal prefixes until one visible final", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(async ({ dispatcherOptions }) => {
      for (const text of [
        "< internal",
        "<  internal",
        "</ internal",
        "< /internal",
        "< / internal",
        "<\u00a0internal",
      ]) {
        await dispatcherOptions.deliver({ text, isReasoning: true }, { kind: "block" });
      }
      expect(reasoningDraftStream.update).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      await dispatcherOptions.deliver({ text: "VISIBLE" }, { kind: "final" });
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "VISIBLE",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivered = expectDeliveredReply(0, { text: "🧠 _hidden_" });
    expect(delivered).not.toHaveProperty("isReasoning");
  });

  it("does not persist typed reasoning-only finals in progress stream mode", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(answerDraftStream.update).not.toHaveBeenCalled();
  });

  it("keeps unflagged angle-bracket text visible on the answer lane", async () => {
    const { answerDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Before <think>literal tag text after" },
        { kind: "final" },
      );
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Before <think>literal tag text after",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not add silent fallback when source delivery is message-tool-only", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(messageToolOnlyDispatchResult);

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:direct:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "allow",
              internal: "allow",
            },
          },
        },
      },
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });
});
