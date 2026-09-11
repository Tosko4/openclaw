import path from "node:path";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { recordConversationObservation } from "openclaw/plugin-sdk/reply-history";
import {
  buildConversationIdentity,
  getSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import type { ComponentData } from "../internal/discord.js";
import {
  createCfg,
  createComponentContext,
  createComponentButtonInteraction,
  createButtonEntry,
  createGuildPluginButtonInteraction,
  discordTestSendResult,
} from "../test-support/component-fixtures.js";
import {
  dispatchReplyMock,
  recordInboundSessionMock,
  resetDiscordComponentRuntimeMocks,
  resolveStorePathMock,
} from "../test-support/component-runtime.js";

type CreateDiscordComponentButton =
  (typeof import("./agent-components.js").createDiscordComponentControls)[number];

let createDiscordComponentButton: CreateDiscordComponentButton;
let registerDiscordComponentEntries: typeof import("../components-registry.js").registerDiscordComponentEntries;
let sendComponents: typeof import("../send.components.js");

describe("Discord component conversation routing", () => {
  beforeAll(async () => {
    const components = await import("./agent-components.js");
    const createButton = components.createDiscordComponentControls[0];
    if (!createButton) {
      throw new Error("missing Discord button factory");
    }
    createDiscordComponentButton = createButton;
    ({ registerDiscordComponentEntries } = await import("../components-registry.js"));
    sendComponents = await import("../send.components.js");
  });

  beforeEach(() => {
    vi.spyOn(sendComponents, "editDiscordComponentMessage").mockResolvedValue(
      discordTestSendResult("msg-1"),
    );
    clearDiscordComponentEntriesForTest();
    resetDiscordComponentRuntimeMocks();
    dispatchReplyMock.mockImplementation(async (params) => {
      await params.dispatcherOptions.deliver({ text: "ok" }, { kind: "final" });
      return { queuedFinal: false, counts: { block: 0, final: 1, tool: 0 } };
    });
  });

  it("includes unread room discussion when an agent-created button continues the conversation", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const scope = { agentId: "agent-1", storePath, sessionKey: "session-1" };
      const sessionId = "component-history-session";
      const conversation = buildConversationIdentity({
        channel: "discord",
        accountId: "default",
        kind: "channel",
        peerId: "guild-channel",
        deliveryTarget: "channel:guild-channel",
        nativeChannelId: "guild-channel",
      })!;
      await upsertSessionEntry({ ...scope, entry: { sessionId, updatedAt: Date.now() } });
      await recordConversationObservation(scope, {
        conversationRef: conversation.conversationRef,
        sourceId: "room-discussion",
        message: { text: "Approve the revised route through the east entrance." },
      });
      resolveStorePathMock.mockReturnValue(storePath);
      registerDiscordComponentEntries({ entries: [createButtonEntry()], modals: [] });
      const button = createDiscordComponentButton(
        createComponentContext({ cfg: { ...createCfg(), session: { store: storePath } } }),
      );
      const { interaction } = createGuildPluginButtonInteraction("component-history-interaction");
      await button.run(interaction, { cid: "btn_1" });
      expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
      const capture = dispatchReplyMock.mock.calls[0]![0].ctx.ConversationHistory;
      expect(capture?.conversationRef).toBe(conversation.conversationRef);
      expect(capture?.requestSourceIds).toEqual(["interaction:component-history-interaction"]);
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const recorder = createRecorder({
        input: { text: 'Clicked "Approve".', idempotencyKey: "component-history-interaction" },
        target: { ...scope, sessionId, sessionEntry: getSessionEntry(scope) },
      });
      await recorder.stageApproved!({
        runId: "component-history-interaction",
        conversationHistory: capture,
        assertCurrent: () => {},
      });
      try {
        expect(recorder.message?.content).toContain(
          "Approve the revised route through the east entrance.",
        );
      } finally {
        recorder.finishPendingInput?.("cancelled");
      }
    });
  });

  it("records DM component interactions with user originating targets", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    const lastDispatchCtx = dispatchReplyMock.mock.lastCall?.[0].ctx;
    expect(lastDispatchCtx?.OriginatingTo).toBe("user:123456789");
    expect(lastDispatchCtx?.To).toBe("channel:dm-channel");
    const recordParams = recordInboundSessionMock.mock.lastCall?.[0] as {
      ctx?: Record<string, unknown>;
      updateLastRoute?: {
        channel?: string;
        mainDmOwnerPin?: unknown;
        sessionKey?: string;
        to?: string;
      };
    };
    expect(recordParams.ctx?.OriginatingTo).toBe("user:123456789");
    expect(recordParams.ctx?.To).toBe("channel:dm-channel");
    expect(recordParams.updateLastRoute?.sessionKey).toBe("session-1");
    expect(recordParams.updateLastRoute?.sessionKey).not.toBe("agent:agent-1:main");
    expect(recordParams.updateLastRoute?.channel).toBe("discord");
    expect(recordParams.updateLastRoute?.to).toBe("user:123456789");
    expect(recordParams.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });
});
