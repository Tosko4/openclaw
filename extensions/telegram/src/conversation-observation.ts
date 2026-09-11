import type { Message } from "grammy/types";
import {
  formatLocationText,
  formatMediaPlaceholderText,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  enrichConversationObservation,
  recordConversationObservation,
  type ConversationHistoryCapture,
} from "openclaw/plugin-sdk/reply-history";
import {
  buildConversationIdentity,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createTelegramSupplementalContextChecker } from "./access-groups.js";
import type { TelegramMediaRef } from "./bot-message-context.types.js";
import type { TelegramCommandDispatch } from "./bot-native-command-dispatch.js";
import {
  buildSenderName,
  extractTelegramLocation,
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
  resolveTelegramRichMessagePlaceholder,
  resolveTelegramRichMessageText,
} from "./bot/body-helpers.js";
import { buildTelegramInboundOriginTarget, type TelegramThreadSpec } from "./bot/helpers.js";
import { renderTelegramTextEntities } from "./bot/inbound-text-entities.js";
import { buildTelegramConversationId } from "./topic-conversation.js";

/** Native commands carry context; only commands that start a turn consume it. */
export async function recordTelegramNativeCommand(
  dispatch: Pick<
    TelegramCommandDispatch,
    | "isGroup"
    | "commandAuthorized"
    | "runtimeCfg"
    | "route"
    | "chatId"
    | "threadSpec"
    | "msg"
    | "groupConfig"
    | "topicConfig"
    | "turnSettings"
  >,
): Promise<ConversationHistoryCapture | undefined> {
  if (!dispatch.isGroup || !dispatch.commandAuthorized) {
    return undefined;
  }
  const capture = await recordTelegramConversationMessages({
    agentId: dispatch.route.agentId,
    config: dispatch.runtimeCfg,
    storePath: resolveStorePath(dispatch.runtimeCfg.session?.store, {
      agentId: dispatch.route.agentId,
    }),
    accountId: dispatch.route.accountId,
    chatId: dispatch.chatId,
    threadSpec: dispatch.threadSpec,
    messages: [dispatch.msg],
    isRequest: true,
  });
  const includeSpeaker = createTelegramSupplementalContextChecker({
    cfg: dispatch.runtimeCfg,
    accountId: dispatch.route.accountId,
    isGroup: true,
    allowFrom:
      dispatch.topicConfig?.allowFrom ??
      dispatch.groupConfig?.allowFrom ??
      dispatch.turnSettings.groupAllowFrom,
    mode: resolveChannelContextVisibilityMode({
      cfg: dispatch.runtimeCfg,
      channel: "telegram",
      accountId: dispatch.route.accountId,
    }),
  });
  return {
    ...capture,
    includeMessage: (message, kind = "history") =>
      includeSpeaker({
        kind,
        senderId: message.sender?.id ?? undefined,
        senderUsername: message.sender?.username ?? undefined,
      }),
  };
}

function conversationMessageText(message: Message): string {
  const parts = getTelegramTextParts(message);
  const nativeMedia = resolveTelegramPrimaryMedia(message);
  const location = extractTelegramLocation(message);
  return (
    [
      renderTelegramTextEntities(parts.text, parts.entities),
      location ? formatLocationText(location) : undefined,
    ]
      .filter(Boolean)
      .join("\n") ||
    resolveTelegramRichMessageText(message) ||
    resolveTelegramRichMessagePlaceholder(message) ||
    formatMediaPlaceholderText(nativeMedia ? [{ kind: nativeMedia.kind }] : [])
  );
}

function toConversationMedia(media: readonly TelegramMediaRef[], messageId: string) {
  return media.map(({ path, kind, contentType, fileName }) => ({
    path,
    kind,
    contentType,
    fileName,
    messageId,
  }));
}

/** Enrich the original intake row before buffering can release its transport lane. */
export async function recordTelegramConversationMedia(
  capture: ConversationHistoryCapture,
  messageId: string,
  media: readonly TelegramMediaRef[],
  config: OpenClawConfig,
): Promise<void> {
  const sourceId = capture.requestSourceIds[0];
  if (capture.requestSourceIds.length !== 1 || !sourceId) {
    throw new Error("Telegram media enrichment requires its original source capture");
  }
  await enrichConversationObservation(
    capture,
    sourceId,
    { media: toConversationMedia(media, messageId) },
    { config },
  );
}

/** Normalize Telegram source events once before core assigns their durable sequence. */
export async function recordTelegramConversationMessages(params: {
  agentId: string;
  storePath: string;
  config?: OpenClawConfig;
  isRequest?: boolean;
  accountId: string;
  chatId: string | number;
  threadSpec: TelegramThreadSpec;
  messages: readonly Message[];
  media?: readonly TelegramMediaRef[];
  updateIds?: readonly (number | undefined)[];
  interactionId?: string;
}): Promise<ConversationHistoryCapture> {
  const identity = buildConversationIdentity({
    channel: "telegram",
    accountId: params.accountId,
    kind: "group",
    peerId: buildTelegramConversationId({ chatId: params.chatId, thread: params.threadSpec }),
    deliveryTarget: buildTelegramInboundOriginTarget(params.chatId, params.threadSpec),
    threadId: params.threadSpec.id,
  });
  if (!identity) {
    throw new Error("Telegram group observation requires a conversation identity");
  }
  const requestSourceIds: string[] = [];
  let capture: ConversationHistoryCapture | undefined;
  for (const [index, message] of params.messages.entries()) {
    const media =
      params.media?.filter((item) =>
        item.sourceMessageId
          ? item.sourceMessageId === String(message.message_id)
          : params.messages.length === 1,
      ) ?? [];
    const text = conversationMessageText(message);
    const reply = message.reply_to_message;
    const editUpdateId = message.edit_date ? params.updateIds?.[index] : undefined;
    if (message.edit_date && editUpdateId === undefined) {
      throw new Error("Telegram edited-message observation requires its native update identity");
    }
    const sourceId = params.interactionId
      ? `interaction:${params.interactionId}`
      : editUpdateId !== undefined
        ? `edit:${editUpdateId}`
        : String(message.message_id);
    requestSourceIds.push(sourceId);
    capture = await recordConversationObservation(
      { agentId: params.agentId, storePath: params.storePath, config: params.config },
      {
        conversationRef: identity.conversationRef,
        sourceId,
        isRequest: params.isRequest,
        message: {
          text: message.edit_date
            ? `[Edited Telegram message ${message.message_id}]\n${text}`
            : text,
          timestamp: message.date * 1000,
          sender: {
            id: message.from?.id?.toString(),
            name: buildSenderName(message),
            username: message.from?.username,
          },
          media: toConversationMedia(media, String(message.message_id)),
          replyTo: reply
            ? {
                text: message.quote
                  ? renderTelegramTextEntities(message.quote.text, message.quote.entities)
                  : conversationMessageText(reply),
                sender: {
                  id: reply.from?.id?.toString(),
                  name: buildSenderName(reply),
                  username: reply.from?.username,
                },
                messageId: String(reply.message_id),
                timestamp: reply.date * 1000,
              }
            : undefined,
          transport: {
            channel: "telegram",
            conversationRef: identity.conversationRef,
            messageId: String(message.message_id),
            replyToId: message.reply_to_message?.message_id.toString(),
            threadId: params.threadSpec.id?.toString(),
          },
        },
      },
    );
  }
  if (!capture) {
    throw new Error("Telegram observation requires a received message");
  }
  return { ...capture, requestSourceIds };
}
