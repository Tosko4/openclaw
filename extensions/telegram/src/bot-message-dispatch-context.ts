import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramInboundOriginTarget,
  buildTypingThreadParams,
  type TelegramThreadSpec,
} from "./bot/helpers.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

function resolveTelegramForumThreadScopeFromSessionKey(
  sessionKey: unknown,
): { chatId: string; threadId: number } | undefined {
  if (typeof sessionKey !== "string") {
    return undefined;
  }
  const match = /:telegram:group:(-?\d+):topic:(\d+)(?::|$)/.exec(sessionKey);
  const threadId = parseStrictPositiveInteger(match?.[2]);
  if (!match?.[1] || threadId == null) {
    return undefined;
  }
  return { chatId: match[1], threadId };
}

function resolveDispatchTelegramThreadSpec(params: {
  chatId: TelegramMessageContext["chatId"];
  ctxPayload: TelegramMessageContext["ctxPayload"];
  threadSpec: TelegramThreadSpec;
}): TelegramThreadSpec {
  if (
    params.threadSpec.scope !== "forum" ||
    (params.threadSpec.id != null && params.threadSpec.id !== TELEGRAM_GENERAL_TOPIC_ID)
  ) {
    return params.threadSpec;
  }
  const scopedThread = resolveTelegramForumThreadScopeFromSessionKey(params.ctxPayload.SessionKey);
  const scopedThreadId =
    scopedThread?.chatId === String(params.chatId) ? scopedThread.threadId : undefined;
  const payloadThreadId =
    parseStrictPositiveInteger(params.ctxPayload.MessageThreadId) ??
    parseStrictPositiveInteger(params.ctxPayload.TransportThreadId);
  // Missing forum IDs are normalized to General; topic-scoped turn facts are more specific.
  const recoveredThreadId = scopedThreadId ?? payloadThreadId;
  return recoveredThreadId == null || recoveredThreadId === params.threadSpec.id
    ? params.threadSpec
    : { ...params.threadSpec, id: recoveredThreadId };
}

function normalizeDispatchTelegramThreadPayload(params: {
  context: TelegramMessageContext;
  threadSpec: TelegramThreadSpec;
}): TelegramMessageContext {
  if (params.threadSpec.scope !== "forum" || params.threadSpec.id == null) {
    return params.context;
  }
  const messageThreadId = parseStrictPositiveInteger(params.context.ctxPayload.MessageThreadId);
  const transportThreadId = parseStrictPositiveInteger(params.context.ctxPayload.TransportThreadId);
  if (messageThreadId === params.threadSpec.id && transportThreadId === params.threadSpec.id) {
    return params.context;
  }
  // This payload owns private host admission state outside its enumerable fields.
  // Normalize routing in place so a plugin-visible copier is never needed.
  Object.assign(params.context.ctxPayload, {
    MessageThreadId: params.threadSpec.id,
    TransportThreadId: params.threadSpec.id,
  });
  return params.context;
}

function buildRecoveredTelegramChatActionSender(params: {
  context: TelegramMessageContext;
  threadId?: number;
  action: "typing" | "record_voice";
}): () => Promise<void> {
  return async () => {
    try {
      await withTelegramApiErrorLogging({
        operation: "sendChatAction",
        fn: () =>
          params.context.sendChatActionHandler.sendChatAction(
            params.context.chatId,
            params.action,
            buildTypingThreadParams(params.threadId),
          ),
      });
    } catch (err) {
      if (params.action !== "record_voice") {
        throw err;
      }
      logVerbose(
        `telegram record_voice cue failed for chat ${params.context.chatId}: ${String(err)}`,
      );
    }
  };
}

export function resolveDispatchTelegramContext(params: {
  context: TelegramMessageContext;
}): TelegramMessageContext {
  // Captured context belongs to the native room/thread chosen at intake.
  // A session-key hint cannot move those messages into another conversation.
  const threadSpec = params.context.ctxPayload.ConversationHistory
    ? params.context.threadSpec
    : resolveDispatchTelegramThreadSpec({
        chatId: params.context.chatId,
        ctxPayload: params.context.ctxPayload,
        threadSpec: params.context.threadSpec,
      });
  if (threadSpec === params.context.threadSpec || threadSpec.scope !== "forum") {
    return normalizeDispatchTelegramThreadPayload({ context: params.context, threadSpec });
  }
  const recoveredRoutingTarget = buildTelegramInboundOriginTarget(
    params.context.chatId,
    threadSpec,
  );
  const recoveredUpdateLastRoute =
    params.context.turn.record.updateLastRoute && threadSpec.id != null
      ? {
          ...params.context.turn.record.updateLastRoute,
          to: `telegram:${params.context.chatId}:topic:${threadSpec.id}`,
          threadId: String(threadSpec.id),
        }
      : params.context.turn.record.updateLastRoute;
  if (threadSpec.id != null) {
    // Keep the admitted payload object intact; replacing it would discard the
    // host-only participant carrier before canonical run admission.
    Object.assign(params.context.ctxPayload, {
      From: params.context.isGroup
        ? buildTelegramGroupFrom(params.context.chatId, threadSpec)
        : params.context.ctxPayload.From,
      MessageThreadId: threadSpec.id,
      OriginatingTo: recoveredRoutingTarget,
      To: recoveredRoutingTarget,
      TransportThreadId: threadSpec.id,
    });
  }
  return {
    ...params.context,
    historyKey: params.context.isGroup
      ? buildTelegramGroupPeerId(params.context.chatId, threadSpec)
      : params.context.historyKey,
    threadSpec,
    resolvedThreadId: threadSpec.id,
    replyThreadId: threadSpec.id,
    sendTyping: buildRecoveredTelegramChatActionSender({
      context: params.context,
      threadId: threadSpec.id,
      action: "typing",
    }),
    sendRecordVoice: buildRecoveredTelegramChatActionSender({
      context: params.context,
      threadId: threadSpec.id,
      action: "record_voice",
    }),
    turn: {
      ...params.context.turn,
      record: {
        ...params.context.turn.record,
        updateLastRoute: recoveredUpdateLastRoute,
      },
    },
  };
}
