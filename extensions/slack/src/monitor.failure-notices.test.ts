import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
} from "./monitor.test-helpers.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const { monitorSlackProvider } = await import("./monitor/provider.js");
const slackTestState = getSlackTestState();
const AUTH_FAILURE = "⚠️ Model login expired on the gateway.";
const BACKEND_FAILURE = "⚠️ Codex app-server is unavailable.";

type SlackFailureTestEvent = {
  type: "message";
  user: string;
  text: string;
  ts: string;
  channel: string;
  channel_type: "im" | "mpim" | "channel";
  thread_ts?: string;
  parent_user_id?: string;
};

function makeEvent(overrides: Partial<SlackFailureTestEvent>): SlackFailureTestEvent {
  return {
    type: "message",
    user: "U1",
    text: "ordinary follow-up",
    ts: "100.000001",
    channel: "C1",
    channel_type: "channel",
    ...overrides,
  };
}

async function dispatchEvent(overrides: Partial<SlackFailureTestEvent>): Promise<void> {
  await runSlackMessageOnce(
    monitorSlackProvider,
    { event: makeEvent(overrides) },
    { awaitDispatch: true },
  );
}

function mockReplySequence(...payloads: Array<{ text: string; isError?: boolean }>): void {
  let runIndex = 0;
  slackTestState.replyMock.mockImplementation(async (...args: unknown[]) => {
    const options = args[1] as { onAgentRunStart?: (runId: string) => void } | undefined;
    options?.onAgentRunStart?.(`slack-failure-notice-test-${runIndex}`);
    const payload = payloads[Math.min(runIndex, payloads.length - 1)];
    runIndex += 1;
    return payload;
  });
}

function disableChannelMentionRequirement(replyToMode: "all" | "off" = "all"): void {
  slackTestState.config = {
    messages: { groupChat: { visibleReplies: "automatic" } },
    channels: {
      slack: {
        dm: { enabled: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        requireMention: false,
        replyToMode,
        channels: { C1: { allow: true, requireMention: false } },
      },
    },
  };
}

describe("Slack thread failure notices", () => {
  beforeEach(() => {
    resetInboundDedupe();
    clearSlackThreadParticipationCache();
    resetSlackTestState({
      messages: { groupChat: { visibleReplies: "automatic" } },
      channels: {
        slack: {
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          requireMention: true,
          replyToMode: "all",
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    });
  });

  it("shows an explicit request failure without invoking passive follow-ups", async () => {
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ text: "<@bot-user> please help", ts: "100.000000" });
    await dispatchEvent({ ts: "100.000001", thread_ts: "100.000000", parent_user_id: "U1" });
    await dispatchEvent({ ts: "100.000002", thread_ts: "100.000000", parent_user_id: "U1" });

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps each failure visible for native replies to the bot thread root", async () => {
    mockReplySequence(
      { text: AUTH_FAILURE, isError: true },
      { text: AUTH_FAILURE, isError: true },
      { text: BACKEND_FAILURE, isError: true },
      { text: "Recovered" },
      { text: AUTH_FAILURE, isError: true },
    );

    for (const ts of ["103.000001", "103.000002", "103.000003", "103.000004", "103.000005"]) {
      await dispatchEvent({ ts, thread_ts: "103.000000", parent_user_id: "bot-user" });
    }

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(5);
    expect(slackTestState.sendMock.mock.calls.map(([, text]) => text)).toEqual([
      AUTH_FAILURE,
      AUTH_FAILURE,
      BACKEND_FAILURE,
      "Recovered",
      AUTH_FAILURE,
    ]);
  });

  it("always explains the current failure when the user explicitly mentions the bot", async () => {
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ text: "<@bot-user> please help", ts: "104.000000" });
    await dispatchEvent({ ts: "104.000001", thread_ts: "104.000000", parent_user_id: "U1" });
    await dispatchEvent({
      text: "<@bot-user> are you working now?",
      ts: "104.000002",
      thread_ts: "104.000000",
      parent_user_id: "U1",
    });

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });

  it.each(["all", "off"] as const)(
    "does not invoke unmentioned channel messages with reply mode %s",
    async (replyToMode) => {
      disableChannelMentionRequirement(replyToMode);
      mockReplySequence({ text: AUTH_FAILURE, isError: true });

      await dispatchEvent({ ts: "105.000000" });
      await dispatchEvent({ ts: "105.000001" });

      expect(slackTestState.replyMock).not.toHaveBeenCalled();
      expect(slackTestState.sendMock).not.toHaveBeenCalled();
    },
  );

  it("shows the explicit request failure after observing unmentioned chatter", async () => {
    disableChannelMentionRequirement();
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ ts: "105.030000" });
    await dispatchEvent({ ts: "105.030001" });
    await dispatchEvent({ text: "<@bot-user> are you working now?", ts: "105.030002" });

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(1);
    expect(slackTestState.sendMock.mock.calls[0]?.[1]).toBe(AUTH_FAILURE);
  });

  it("does not retry an ambiguous send and still answers a new native request", async () => {
    mockReplySequence(
      { text: "Working normally" },
      { text: AUTH_FAILURE, isError: true },
      { text: AUTH_FAILURE, isError: true },
    );

    await dispatchEvent({ text: "<@bot-user> please help", ts: "105.040000" });
    const failure = new Error("Slack delivery unavailable");
    slackTestState.sendMock.mockRejectedValueOnce(failure);

    await expect(
      dispatchEvent({
        text: "<@bot-user> retry the request",
        ts: "105.040001",
        thread_ts: "105.040000",
        parent_user_id: "U1",
      }),
    ).rejects.toBe(failure);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
    await dispatchEvent({
      text: "<@bot-user> try once more",
      ts: "105.040002",
      thread_ts: "105.040000",
      parent_user_id: "U1",
    });

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(3);
  });

  it("does not suppress warnings for non-terminal tool failures", async () => {
    const warning = setReplyPayloadMetadata(
      { text: "A tool failed, but the run completed.", isError: true },
      { nonTerminalToolErrorWarning: true },
    );
    mockReplySequence({ text: "Working normally" }, warning, warning);

    await dispatchEvent({ text: "<@bot-user> please help", ts: "105.100000" });
    await dispatchEvent({
      text: "<@bot-user> continue",
      ts: "105.100001",
      thread_ts: "105.100000",
      parent_user_id: "U1",
    });
    await dispatchEvent({
      text: "<@bot-user> continue",
      ts: "105.100002",
      thread_ts: "105.100000",
      parent_user_id: "U1",
    });

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(3);
  });

  it("keeps failures visible in direct messages", async () => {
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({ channel: "D1", channel_type: "im", ts: "106.000000" });
    await dispatchEvent({ channel: "D1", channel_type: "im", ts: "106.000001" });

    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });

  it("keeps failures visible in Slack group direct messages", async () => {
    slackTestState.config = {
      messages: { groupChat: { visibleReplies: "automatic" } },
      channels: {
        slack: {
          dm: { enabled: true, groupEnabled: true },
          dmPolicy: "open",
          allowFrom: ["U1"],
          groupPolicy: "open",
          replyToMode: "off",
        },
      },
    };
    mockReplySequence({ text: AUTH_FAILURE, isError: true });

    await dispatchEvent({
      text: "<@bot-user> please help",
      channel: "G1",
      channel_type: "mpim",
      ts: "107.000000",
    });
    await dispatchEvent({
      text: "<@bot-user> please help",
      channel: "G1",
      channel_type: "mpim",
      ts: "107.000001",
    });

    expect(slackTestState.replyMock).toHaveBeenCalledTimes(2);
    expect(slackTestState.sendMock).toHaveBeenCalledTimes(2);
  });
});
