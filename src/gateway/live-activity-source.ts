import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import type {
  LiveActivityObservation,
  LiveActivitySnapshot,
} from "../infra/push-live-activity-store.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const liveActivitySource = Symbol("liveActivitySource");

export type LiveActivitySource = Readonly<{
  publicRunId: string;
  internalRunId: string;
  contextClaimId: string;
  lifecycleGeneration: string;
  sourceIncarnation: string;
  entry: ChatAbortControllerEntry;
  agentId: string;
  sessionKey: string;
  preparedSession: Readonly<{ sessionId: string; lifecycleRevision: string | null }>;
}>;

/** One slot on the exact admitted chat owner, never an independent run registry. */
export type LiveActivityRunFact = Readonly<{
  source: LiveActivitySource;
  snapshot: Readonly<LiveActivitySnapshot> | null;
}>;

export type CommittedLiveActivityFact = Readonly<{
  source: LiveActivitySource;
  publicRunId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  snapshot: Readonly<LiveActivityObservation>;
}>;

export function captureLiveActivitySource(
  event: Pick<AgentEventRuntimePayload, "runId" | "contextClaimId" | "lifecycleGeneration">,
  entry: ChatAbortControllerEntry,
): LiveActivitySource | undefined {
  const mapping = entry.liveActivityRun;
  if (
    !mapping ||
    mapping.internalRunId !== event.runId ||
    !entry.preparedSession ||
    !entry.agentId ||
    !event.contextClaimId ||
    !event.lifecycleGeneration ||
    entry.lifecycleGeneration !== event.lifecycleGeneration
  ) {
    return undefined;
  }
  const previous = entry.liveActivityFact?.source;
  if (
    previous?.entry === entry &&
    previous.internalRunId === event.runId &&
    previous.contextClaimId === event.contextClaimId &&
    previous.lifecycleGeneration === event.lifecycleGeneration
  ) {
    return previous;
  }
  return Object.freeze({
    publicRunId: mapping.publicRunId,
    internalRunId: event.runId,
    contextClaimId: event.contextClaimId,
    lifecycleGeneration: event.lifecycleGeneration,
    sourceIncarnation: JSON.stringify([event.lifecycleGeneration, event.contextClaimId]),
    entry,
    agentId: entry.agentId,
    sessionKey: entry.sessionKey,
    preparedSession: entry.preparedSession,
  });
}

/** Private ingress provenance must survive async persistence, never a public event spread. */
export function attachLiveActivitySource(
  event: AgentEventRuntimePayload,
  source: LiveActivitySource,
) {
  Object.defineProperty(event, liveActivitySource, { value: source });
}

export function readLiveActivitySource(
  event: Pick<AgentEventRuntimePayload, "runId"> & { [liveActivitySource]?: LiveActivitySource },
): LiveActivitySource | undefined {
  return event[liveActivitySource];
}

export function isLiveActivityTerminal(
  snapshot: Readonly<LiveActivityObservation>,
): snapshot is Readonly<
  Extract<LiveActivityObservation, { status: "done" | "failed" | "killed" | "timeout" }>
> {
  return (
    snapshot.status === "done" ||
    snapshot.status === "failed" ||
    snapshot.status === "killed" ||
    snapshot.status === "timeout"
  );
}
