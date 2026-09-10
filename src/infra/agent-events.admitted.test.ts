import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitAgentEvent,
  emitAgentEventForAdmittedRun,
  emitAgentEventForOwner,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
  type AgentEventRuntimePayload,
} from "./agent-events.js";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunContext,
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunContextOwnerStatus,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

const runId = "admitted-event-run";
const start = {
  runId,
  stream: "lifecycle",
  data: { phase: "start", startedAt: 1_000 },
};

function createOwner(assertSourceCurrent?: () => void) {
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionKey: "agent:main:admitted-event",
    sessionId: "admitted-event-session",
  });
  return claimAgentRunDelegatedAuthority(
    { instanceId: "admitted-event-instance", runId },
    assertSourceCurrent,
  );
}

let events: AgentEventRuntimePayload[];
beforeEach(() => {
  resetAgentEventsForTest();
  events = [];
  onAgentRuntimeEvent((event) => events.push(event));
});
afterEach(() => resetAgentEventsForTest());

describe("exact admitted-run event authority", () => {
  it("stamps the actual root claim privately before the first running event", () => {
    const root = createOwner();
    expect(emitAgentEventForAdmittedRun(start, root)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...start,
      seq: 1,
      contextClaimId: root.claimId,
      lifecycleGeneration: root.lifecycleGeneration,
      agentId: "main",
      sessionKey: "agent:main:admitted-event",
      sessionId: "admitted-event-session",
    });
    const event = events[0];
    if (!event) {
      throw new Error("Expected the admitted running event");
    }
    expect(Object.keys(event)).not.toContain("contextClaimId");
    expect(Object.keys(event)).not.toContain("lifecycleGeneration");
    expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBe(1_000);
  });

  it.each(["copy", "subordinate", "different-run", "different-generation"] as const)(
    "rejects %s without consuming sequence or changing start metadata",
    (kind) => {
      const root = createOwner();
      const candidate =
        kind === "copy"
          ? { ...root, operationalRunInstance: { ...root.operationalRunInstance } }
          : kind === "subordinate"
            ? claimAgentRunApprovalAuthority(root, [new AbortController().signal])
            : root;
      const event =
        kind === "different-run"
          ? { ...start, runId: "another-run" }
          : kind === "different-generation"
            ? { ...start, lifecycleGeneration: "retired-generation" }
            : start;
      if (kind === "copy" || kind === "subordinate") {
        expect(validateAgentRunDelegatedAuthority(candidate)).toBe(true);
      }
      const lastActiveAt = getAgentRunContext(runId)?.lastActiveAt;

      expect(emitAgentEventForAdmittedRun(event, candidate)).toBe(false);
      expect(events).toEqual([]);
      expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBeUndefined();
      expect(getAgentRunContext(runId)?.lastActiveAt).toBe(lastActiveAt);
      expect(emitAgentEventForAdmittedRun(start, root)).toBe(true);
      expect(events.map((accepted) => accepted.seq)).toEqual([1]);
    },
  );

  it.each(["closed", "clear-requested"] as const)(
    "rejects a %s root even while its projection context remains",
    (state) => {
      const root = createOwner();
      if (state === "closed") {
        releaseAgentRunDelegatedAuthority(root);
      } else {
        clearAgentRunContext(runId, root.lifecycleGeneration);
        expect(getAgentRunContextOwnerStatus(runId, root.claimId, root.lifecycleGeneration)).toBe(
          "clear-requested",
        );
        expect(validateAgentRunDelegatedAuthority(root)).toBe(true);
      }
      expect(getAgentRunContext(runId)).toBeDefined();
      expect(emitAgentEventForAdmittedRun(start, root)).toBe(false);
      expect(events).toEqual([]);
      expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBeUndefined();
      emitAgentEvent({ runId, stream: "assistant", data: { text: "ordinary event" } });
      expect(events.map((accepted) => accepted.seq)).toEqual([1]);
      const event = events[0];
      if (!event) {
        throw new Error("Expected the ordinary unowned event");
      }
      expect(event.contextClaimId).toBeUndefined();
    },
  );

  it.each(["source", "attempt"] as const)(
    "rechecks root identity after a reentrant %s callback replaces it",
    (boundary) => {
      let duringCheck: (() => void) | undefined;
      const root = createOwner(() => {
        const callback = duringCheck;
        duringCheck = undefined;
        callback?.();
      });
      let successor: typeof root | undefined;
      const replace = () => {
        successor = claimAgentRunDelegatedAuthority({
          instanceId: "replacement-event-instance",
          runId,
        });
      };
      if (boundary === "source") {
        duringCheck = replace;
      }
      expect(
        emitAgentEventForAdmittedRun(start, root, () => {
          if (boundary === "attempt") {
            replace();
          }
          return true;
        }),
      ).toBe(false);
      expect(events).toEqual([]);
      expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBeUndefined();
      if (!successor) {
        throw new Error("Expected replacement from the authority callback");
      }
      expect(emitAgentEventForAdmittedRun(start, successor)).toBe(true);
      expect(events.map((accepted) => [accepted.seq, accepted.contextClaimId])).toEqual([
        [1, successor.claimId],
      ]);
    },
  );

  it("rejects a callback's clear request before sequence or lifecycle mutation", () => {
    const root = createOwner();
    expect(
      emitAgentEventForAdmittedRun(start, root, () => {
        clearAgentRunContext(runId, root.lifecycleGeneration);
        return true;
      }),
    ).toBe(false);
    expect(events).toEqual([]);
    expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBeUndefined();
    emitAgentEvent({ runId, stream: "assistant", data: {} });
    expect(events[0]?.seq).toBe(1);
  });

  it("allows nested publication without transferring authority or consuming a rejected sequence", () => {
    const root = createOwner();
    expect(
      emitAgentEventForAdmittedRun(start, root, () => {
        emitAgentEvent({ runId: "unbound-child", stream: "assistant", data: { text: "child" } });
        expect(
          emitAgentEventForAdmittedRun(
            { runId, stream: "assistant", data: { text: "nested" } },
            root,
          ),
        ).toBe(true);
        return false;
      }),
    ).toBe(false);
    expect(getAgentRunContext(runId)?.lifecycleStartedAt).toBeUndefined();
    expect(emitAgentEventForAdmittedRun(start, root)).toBe(true);
    expect(events.map((event) => [event.runId, event.seq, event.contextClaimId])).toEqual([
      ["unbound-child", 1, undefined],
      [runId, 1, root.claimId],
      [runId, 2, root.claimId],
    ]);
  });

  it("preserves explicit worker exclusivity and ordinary unowned emission", () => {
    const root = createOwner();
    const workerClaim = claimAgentRunContext(
      "worker-run",
      { sessionKey: "agent:main:worker" },
      { exclusive: true, trackOwner: true },
    );
    if (!workerClaim) {
      throw new Error("Expected the exclusive worker claim");
    }
    const workerEvent = { runId: "worker-run", stream: "assistant", data: {} };
    emitAgentEventForOwner(start, root.claimId);
    expect(emitAgentEventForAdmittedRun(workerEvent, root)).toBe(false);
    emitAgentEvent(workerEvent);
    emitAgentEventForOwner(workerEvent, workerClaim);
    emitAgentEvent({ runId: "ordinary-run", stream: "assistant", data: {} });
    expect(emitAgentEventForAdmittedRun(start, root)).toBe(true);

    expect(events.map((event) => [event.runId, event.seq, event.contextClaimId])).toEqual([
      ["worker-run", 1, workerClaim],
      ["ordinary-run", 1, undefined],
      [runId, 1, root.claimId],
    ]);
  });
});
