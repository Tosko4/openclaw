import { ChannelType } from "discord-api-types/v10";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { vi } from "vitest";
import type { DiscordComponentEntry } from "../components.js";
import type { ButtonInteraction } from "../internal/discord.js";
import { createDiscordSendReceipt } from "../send.receipt.js";

type CreateDiscordComponentButton =
  (typeof import("../monitor/agent-components.js").createDiscordComponentControls)[number];

export const createCfg = (): OpenClawConfig =>
  ({
    channels: {
      discord: {
        replyToMode: "first",
      },
    },
  }) as OpenClawConfig;

export const createDiscordConfig = (
  overrides?: Partial<DiscordAccountConfig>,
): DiscordAccountConfig =>
  ({
    replyToMode: "first",
    ...overrides,
  }) as DiscordAccountConfig;

type ComponentContext = Parameters<CreateDiscordComponentButton>[0];

export const createComponentContext = (overrides?: Partial<ComponentContext>) =>
  ({
    cfg: createCfg(),
    accountId: "default",
    dmPolicy: "allowlist",
    allowFrom: ["123456789"],
    discordConfig: createDiscordConfig(),
    token: "token",
    ...overrides,
  }) as ComponentContext;

export const createComponentInteractionBase = () => {
  const reply = vi.fn().mockResolvedValue(undefined);
  const defer = vi.fn().mockResolvedValue(undefined);
  const rest = {
    get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    reply,
    defer,
    client: { rest },
    user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
    message: { id: "msg-1" },
  };
};

export const createComponentButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
  const base = createComponentInteractionBase();
  const interaction = {
    rawData: { channel_id: "dm-channel", id: "interaction-1" },
    customId: "occomp:cid=btn_1",
    ...base,
    ...overrides,
  } as unknown as ButtonInteraction;
  return { interaction, defer: base.defer, reply: base.reply };
};

export const createButtonEntry = (
  overrides: Partial<DiscordComponentEntry> = {},
): DiscordComponentEntry => ({
  id: "btn_1",
  kind: "button",
  label: "Approve",
  messageId: "msg-1",
  sessionKey: "session-1",
  agentId: "agent-1",
  accountId: "default",
  ...overrides,
});

export const createGuildPluginButtonInteraction = (interactionId: string) =>
  createComponentButtonInteraction({
    rawData: {
      channel_id: "guild-channel",
      guild_id: "guild-1",
      id: interactionId,
      member: { roles: [] },
    } as unknown as ButtonInteraction["rawData"],
    guild: { id: "guild-1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
  });

export function discordTestSendResult(messageId: string, channelId = "dm-channel") {
  return {
    messageId,
    channelId,
    receipt: createDiscordSendReceipt({ platformMessageIds: [messageId], channelId, kind: "card" }),
  };
}
