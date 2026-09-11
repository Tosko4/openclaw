import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  collectChannelAccountScopes,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

export function collectSlackLegacyGroupContextWarnings(cfg: OpenClawConfig): string[] {
  const ignored: string[] = [];
  for (const { prefix, account } of collectChannelAccountScopes({ cfg, channelId: "slack" })) {
    for (const key of [
      "historyLimit",
      "mentionPatterns",
      "ignoreOtherMentions",
      "implicitMentions",
    ]) {
      if (account[key] !== undefined) {
        ignored.push(`${prefix}.${key}`);
      }
    }
    if (account.requireMention === false) {
      ignored.push(`${prefix}.requireMention=false`);
    }
    const thread = asObjectRecord(account.thread);
    for (const key of ["historyScope", "initialHistoryLimit"]) {
      if (thread?.[key] !== undefined) {
        ignored.push(`${prefix}.thread.${key} (rooms only)`);
      }
    }
    for (const [id, value] of Object.entries(asObjectRecord(account.channels) ?? {})) {
      const room = asObjectRecord(value);
      if (room?.requireMention === false) {
        ignored.push(`${prefix}.channels.${id}.requireMention=false`);
      }
      if (room?.ignoreOtherMentions !== undefined) {
        ignored.push(`${prefix}.channels.${id}.ignoreOtherMentions`);
      }
    }
  }
  if (
    cfg.channels?.defaults?.implicitMentions !== undefined &&
    cfg.channels.slack?.implicitMentions === undefined
  ) {
    ignored.push("channels.defaults.implicitMentions");
  }
  const sharedScopes = [
    cfg.messages?.groupChat,
    ...Object.values(cfg.agents?.entries ?? {}).map((agent) => agent.groupChat),
  ];
  for (const key of ["historyLimit", "mentionPatterns", "unmentionedInbound"] as const) {
    if (sharedScopes.some((scope) => scope?.[key] !== undefined)) {
      ignored.push(`groupChat.${key}`);
    }
  }
  return ignored.length
    ? [
        `Slack legacy group settings remain accepted but no longer control room context: ${ignored.join(", ")}. Rooms require native bot mentions, replies to the bot, or bot-owned interactions. Unread room text is retained until an addressed request consumes it. Direct-message history settings still apply; config cleanup is optional.`,
      ]
    : [];
}
