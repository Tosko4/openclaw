/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { SessionLocalSource } from "../../lib/sessions/local-source.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { localInputFooterLabel, readLocalInputFooter } from "./chat-local-input-footer.ts";
import {
  applyLocalInputEvent,
  readRejectedLocalInput,
  recordLocalInputSubmission,
  resolveActiveRunSend,
  retireLocalInputsForMessages,
  takeRejectedLocalInput,
} from "./chat-local-input.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";

const sessionKey = "agent:main:live-local";

function makeHost() {
  const host = makeChatHost({ sessionKey });
  reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [] });
  return host;
}

function submit(host: ReturnType<typeof makeHost>, inputId = "in-1", inputModes = ["steer"]) {
  recordLocalInputSubmission(host, {
    inputId,
    runId: `run-${inputId}`,
    sessionKey,
    agentId: "main",
    source: { sourceLabel: "Codex", inputModes: inputModes as Array<"steer" | "followup"> },
    message: { text: `hello ${inputId}`, createdAt: 100 },
    scope: readChatSessionProjectionScope(host, { sessionKey, agentId: "main" }),
  });
}

function footers(host: ReturnType<typeof makeHost>) {
  return getChatSessionProjection(host).messages.map((message) => readLocalInputFooter(message));
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

describe("live local input receipts", () => {
  it("shows one optimistic bubble whose footer follows session.localInput events", () => {
    const host = makeHost();
    submit(host);
    expect(footers(host)).toEqual([
      { inputId: "in-1", sourceLabel: "Codex", nextTurnDelivery: false, state: "accepted" },
    ]);

    expect(
      applyLocalInputEvent(host, {
        sessionKey,
        agentId: "main",
        inputId: "in-1",
        state: "submitted",
      }),
    ).toBe(true);
    expect(footers(host).map((footer) => footer?.state)).toEqual(["submitted"]);
    // A repeated state is not a change worth a re-render.
    expect(
      applyLocalInputEvent(host, {
        sessionKey,
        agentId: "main",
        inputId: "in-1",
        state: "submitted",
      }),
    ).toBe(false);
    expect(applyLocalInputEvent(host, { inputId: "unknown", state: "committed" })).toBe(false);

    applyLocalInputEvent(host, {
      sessionKey,
      agentId: "main",
      inputId: "in-1",
      state: "committed",
    });
    expect(footers(host)).toEqual([
      { inputId: "in-1", sourceLabel: "Codex", nextTurnDelivery: false, state: "committed" },
    ]);
  });

  it("retires the bubble when the device mirrors the record with the same localInputId", () => {
    const host = makeHost();
    submit(host);
    retireLocalInputsForMessages(host, [
      { role: "user", content: "other", __openclaw: { localInputId: "other" } },
    ]);
    expect(footers(host)).toHaveLength(1);
    retireLocalInputsForMessages(host, [
      { role: "user", content: "hello in-1", __openclaw: { localInputId: "in-1" } },
    ]);
    expect(getChatSessionProjection(host).messages).toEqual([]);
    // The receipt is gone: a late event has nothing to update.
    expect(applyLocalInputEvent(host, { inputId: "in-1", state: "committed" })).toBe(false);
  });

  it("skips the optimistic bubble when the mirrored record already arrived before the ack", () => {
    const host = makeHost();
    reduceChatSessionProjection(host, {
      type: "snapshotLoaded",
      messages: [{ role: "user", content: "hello in-1", __openclaw: { localInputId: "in-1" } }],
    });
    submit(host);
    expect(getChatSessionProjection(host).messages).toHaveLength(1);
    expect(footers(host)).toEqual([null]);
  });

  it("keeps a rejected bubble with its reason and hands it back for retry", () => {
    const host = makeHost();
    submit(host);
    applyLocalInputEvent(host, {
      inputId: "in-1",
      state: "rejected",
      reason: "thread closed",
    });
    expect(footers(host)).toEqual([
      {
        inputId: "in-1",
        sourceLabel: "Codex",
        nextTurnDelivery: false,
        state: "rejected",
        reason: "thread closed",
      },
    ]);
    expect(readRejectedLocalInput(host)?.inputId).toBe("in-1");
    expect(takeRejectedLocalInput(host, "missing")).toBeNull();
    const receipt = takeRejectedLocalInput(host, "in-1");
    expect(receipt?.message.text).toBe("hello in-1");
    expect(getChatSessionProjection(host).messages).toEqual([]);
    expect(readRejectedLocalInput(host)).toBeUndefined();
  });

  it("labels each receipt state for the reader", () => {
    const base = { inputId: "in-1", sourceLabel: "Codex", nextTurnDelivery: false } as const;
    expect(localInputFooterLabel({ ...base, state: "accepted" })).toBe("Sending to the device…");
    expect(localInputFooterLabel({ ...base, state: "submitted" })).toBe("Delivered to Codex");
    expect(localInputFooterLabel({ ...base, nextTurnDelivery: true, state: "submitted" })).toBe(
      "Delivered to Codex; it reads this at the next turn",
    );
    expect(localInputFooterLabel({ ...base, state: "committed" })).toBe("Received by Codex");
    expect(localInputFooterLabel({ ...base, state: "rejected" })).toBe(
      "Codex did not accept this message",
    );
    expect(localInputFooterLabel({ ...base, state: "rejected", reason: "busy" })).toBe(
      "Codex did not accept this message: busy",
    );
    expect(localInputFooterLabel({ ...base, sourceLabel: "", state: "committed" })).toBe(
      "Received by the device",
    );
  });

  it("marks next-turn delivery for sources without steering", () => {
    const host = makeHost();
    submit(host, "in-2", ["followup"]);
    expect(footers(host)[0]?.nextTurnDelivery).toBe(true);
  });

  it.each([
    { state: "idle", modes: ["steer", "followup"], followUp: "steer", queueMode: undefined },
    { state: "active", modes: ["steer", "followup"], followUp: "steer", queueMode: "steer" },
    { state: "active", modes: ["steer", "followup"], followUp: "queue", queueMode: "followup" },
    { state: "active", modes: ["followup"], followUp: "steer", queueMode: "followup" },
    { state: "active", modes: ["followup"], followUp: undefined, queueMode: "followup" },
  ] as const)(
    "resolves the device queue mode for a $state source with $modes and follow-up $followUp",
    (scenario) => {
      const localSource: SessionLocalSource = {
        sourceId: "codex",
        sourceLabel: "Codex",
        deviceId: "mac-1",
        threadId: "thread-1",
        ownerProfileId: "profile-scott",
        ownerLabel: "Scott",
        connected: true,
        state: scenario.state,
        canInput: true,
        inputModes: [...scenario.modes],
      };
      const host = makeChatHost({
        sessionKey,
        sessionsResult: sessionsResult(
          [{ key: sessionKey, kind: "direct", updatedAt: 1, localSource }],
          1,
        ),
      });
      expect(resolveActiveRunSend(host, sessionKey, scenario.followUp)).toEqual({
        queueMode: scenario.queueMode,
        sendNow: false,
      });
    },
  );
});
