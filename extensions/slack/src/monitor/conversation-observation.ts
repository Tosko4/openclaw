import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  recordConversationObservation,
  type ConversationHistoryCapture,
} from "openclaw/plugin-sdk/reply-history";
import { buildConversationIdentity } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSlackFileReference } from "../file-reference.js";
import { formatSlackTarget } from "../target-parsing.js";
import type { SlackMessageEvent } from "../types.js";
import { resolveSlackMessageText } from "./block-text.js";
import { resolveSlackTimestampMs } from "./message-handler/timestamp.js";
import type { SlackThreadStarter } from "./thread.js";

export type SlackMessageSource = {
  message: SlackMessageEvent;
  source: "message" | "app_mention";
};

/** Slack transport identity stays independent of the session chosen for reply delivery. */
export async function recordSlackConversationSources(params: {
  agentId: string;
  storePath: string;
  config: OpenClawConfig;
  accountId: string;
  teamId: string;
  channelId: string;
  kind: "channel" | "group";
  threadTs?: string;
  senderName: string;
  sources: readonly {
    message: SlackMessageEvent;
    isRequest: boolean;
    sourceId?: string;
  }[];
  threadStarter?: SlackThreadStarter | null;
}): Promise<{
  sourceCaptures: Map<SlackMessageEvent, ConversationHistoryCapture>;
  requestCapture: ConversationHistoryCapture | undefined;
}> {
  const target = formatSlackTarget({
    teamId: params.teamId,
    kind: "channel",
    id: params.channelId,
    explicitKind: true,
  });
  const identity = buildConversationIdentity({
    channel: "slack",
    accountId: params.accountId,
    kind: params.kind,
    peerId: target,
    deliveryTarget: target,
    nativeChannelId: params.channelId,
    threadId: params.threadTs,
  });
  if (!identity) {
    throw new Error("Slack room observation requires a conversation identity");
  }
  let requestCapture: ConversationHistoryCapture | undefined;
  const requestSourceIds: string[] = [];
  const sourceCaptures = new Map<SlackMessageEvent, ConversationHistoryCapture>();
  for (const source of params.sources) {
    const { message } = source;
    const sourceId = source.sourceId ?? message.ts ?? message.event_ts;
    if (!sourceId) {
      throw new Error("Slack room observation requires a native source identity");
    }
    const text = [
      resolveSlackMessageText(message),
      ...(message.files?.map((file) => `[Slack file: ${formatSlackFileReference(file)}]`) ?? []),
      ...(message.attachments ?? []).flatMap((attachment) =>
        attachment.is_share || message.bot_id
          ? [attachment.text ?? attachment.fallback].filter(Boolean)
          : [],
      ),
    ]
      .filter(Boolean)
      .join("\n");
    const starter = params.threadStarter;
    const capture = await recordConversationObservation(
      { agentId: params.agentId, storePath: params.storePath, config: params.config },
      {
        conversationRef: identity.conversationRef,
        sourceId,
        isRequest: source.isRequest,
        message: {
          text,
          timestamp: resolveSlackTimestampMs(message.ts ?? message.event_ts),
          sender: { id: message.user ?? message.bot_id, name: params.senderName },
          replyTo: starter?.text
            ? {
                text: starter.text,
                messageId: starter.ts ?? params.threadTs,
                timestamp: resolveSlackTimestampMs(starter.ts),
                sender: { id: starter.userId ?? starter.botId },
              }
            : undefined,
          transport: {
            channel: "slack",
            conversationRef: identity.conversationRef,
            messageId: message.ts ?? message.event_ts,
            replyToId: params.threadTs,
            threadId: params.threadTs,
          },
        },
      },
    );
    sourceCaptures.set(message, capture);
    // Later chatter in the same buffer stays beyond the addressed request's boundary.
    if (source.isRequest) {
      requestCapture = capture;
      requestSourceIds.push(sourceId);
    }
  }
  return {
    sourceCaptures,
    requestCapture: requestCapture ? { ...requestCapture, requestSourceIds } : undefined,
  };
}
