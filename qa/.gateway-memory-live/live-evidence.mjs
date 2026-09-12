import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const toolFlow = process.env.OPENCLAW_PERF_TOOL_FLOW === "1";
export const livePrompt = (index) =>
  toolFlow && index < 2
    ? `Read memory-proof-fixture.txt exactly once using the read tool, then reply with exactly LIVE_GATEWAY_OK_${index + 1} and no other text.`
    : `Reply with exactly LIVE_GATEWAY_OK_${index + 1} and no other text. Do not call tools.`;
export const liveModel = "openai/gpt-5.4";
export const acceptedTurns = [];
const events = [];
let histories = [];
let configuredAgent;
const messageText = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part) => ["text", "output_text"].includes(part.type))
        .map((part) => part.text ?? "")
        .join("");
export function captureLiveEvent(event) {
  if (event.event === "chat" || event.event === "agent") events.push(event);
}
export function requireLiveBudget(options) {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("Runner OPENAI_API_KEY is unavailable");
  if (!process.env.OPENCLAW_PERF_OWNER_PATH)
    throw new Error("Owned-process receipt path is required");
  if (!process.env.OPENCLAW_PERF_HTTP_COUNTS_PATH)
    throw new Error("Owned transport-count path is required");
  if (!process.env.OPENCLAW_PERF_PROFILE_DIR)
    throw new Error("Owned profile output directory is required");
  if (
    options.runs !== 1 ||
    options.warmup !== 0 ||
    options.concurrency !== 8 ||
    options.sessionCount !== 1000 ||
    options.sessionUpdates !== 100 ||
    options.toolEvents ||
    options.historyClients !== 4 ||
    options.historyBurst !== 3 ||
    options.subscribers !== 4 ||
    options.sessionUpdateClients !== 4 ||
    options.cadenceMs !== 100 ||
    options.probeRounds !== 100 ||
    options.historyMessages !== 0 ||
    options.workspaceFanout ||
    !options.controlPlane ||
    !options.visibleObserver ||
    options.diagnosticsTimeline
  ) {
    throw new Error(
      "Live proof requires the recorded fixed 1000-session workload, 8 turns, 100 patches, four history/update/subscription clients, and disabled diagnostics",
    );
  }
}
export async function verifyLiveAgent(rpc) {
  const agents = await rpc("agents.list", {});
  if (!agents.agents?.some((agent) => agent.id === "main"))
    throw new Error("Configured main agent is unavailable");
  const snapshot = await rpc("config.get", {});
  const config = snapshot.config;
  if (config?.plugins?.entries?.["memory-core"]?.config?.dreaming?.enabled !== false)
    throw new Error("Dreaming-disabled config not loaded");
  if (config?.agents?.defaults?.model?.primary !== liveModel)
    throw new Error("Live model config not loaded");
  configuredAgent = {
    agentId: "main",
    model: liveModel,
    dreamingEnabled: false,
    indexing: "canonical default",
  };
}
export function configureLive(config, root, concurrency) {
  config.models = {
    mode: "merge",
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        agentRuntime: { id: "openclaw" },
        models: [
          {
            id: liveModel.slice(7),
            name: "Live proof model",
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 128,
          },
        ],
      },
    },
  };
  config.agents = {
    defaults: {
      workspace: path.join(root, "workspace"),
      maxConcurrent: concurrency,
      model: { primary: liveModel },
      thinkingDefault: "off",
      models: {
        [liveModel]: {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false, maxTokens: 128 },
        },
      },
    },
  };
  config.tools = toolFlow ? { allow: ["read"], codeMode: false } : { deny: ["*"] };
  if (toolFlow) {
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "workspace", "memory-proof-fixture.txt"),
      "SYNTHETIC_MEMORY_PROOF_FILE\nThis file is only a small bounded read fixture.\n",
    );
  }
  config.plugins.entries["memory-core"] = { config: { dreaming: { enabled: false } } };
}
export async function captureLiveHistories(rpc) {
  histories = await Promise.all(
    acceptedTurns.map(async (turn) => {
      const history = await rpc("chat.history", { sessionKey: turn.sessionKey, limit: 20 });
      const assistant = (history.messages ?? []).filter((message) => message.role === "assistant");
      const text = assistant.map(messageText).join("");
      const finalEvents = events.filter(
        (event) =>
          event.event === "chat" &&
          event.payload?.runId === turn.runId &&
          event.payload?.state === "final",
      );
      const deltas = events.filter(
        (event) =>
          event.event === "agent" &&
          event.payload?.runId === turn.runId &&
          event.payload?.stream === "assistant",
      );
      const streamedText = deltas.map((event) => event.payload?.data?.delta ?? "").join("");
      const finalText = finalEvents.map((event) => messageText(event.payload?.message)).join("");
      const toolCalls = assistant
        .flatMap((message) => message.content ?? [])
        .filter((part) => part.type === "toolCall" && part.name === "read").length;
      const toolResults = (history.messages ?? []).filter(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "read" &&
          messageText(message).includes("SYNTHETIC_MEMORY_PROOF_FILE"),
      ).length;
      return {
        ...turn,
        sessionId: history.sessionId,
        assistantCount: assistant.length,
        text,
        toolCalls,
        toolResults,
        toolExpected:
          toolFlow && ["LIVE_GATEWAY_OK_1", "LIVE_GATEWAY_OK_2"].includes(turn.expected),
        finalEventCount: finalEvents.length,
        finalText,
        finalMatches: finalText.trim() === turn.expected,
        streamedText,
        rpcHistoryMatches:
          assistant.filter((message) => messageText(message).trim()).length === 1 &&
          text.trim() === turn.expected,
        streamMatches: streamedText.trim() === turn.expected,
      };
    }),
  );
}
export function selectLiveCleanupSessionKeys(sessionCount, turns) {
  const sessionKeys = Array.from(
    { length: sessionCount },
    (_, index) => `agent:main:gateway-concurrency-${index + 1}`,
  );
  const fixtureKeys = new Set(sessionKeys);
  const retainedKeys = new Set(turns.map((turn) => turn.sessionKey));
  if (
    turns.length !== 8 ||
    retainedKeys.size !== 8 ||
    [...retainedKeys].some((key) => !fixtureKeys.has(key))
  )
    throw new Error("Live cleanup requires eight distinct accepted fixture session keys");
  return sessionKeys.filter((key) => !retainedKeys.has(key));
}
export function recordMeasuredLiveProof(root) {
  const evidence = finishLiveProof(root, "before supported cleanup");
  fs.writeFileSync(
    path.join(process.env.OPENCLAW_PERF_PROFILE_DIR, "measured-live-proof.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  if (!evidence.passed)
    throw new Error("Measured live response/transcript proof failed before cleanup");
}
export function finishLiveProof(root, checkpoint = "after Gateway shutdown") {
  const databasePath = path.join(root, "state", "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(databasePath))
    throw new Error("Owned transcript database missing after Gateway shutdown");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT session_id, event_json FROM transcript_events ORDER BY session_id, seq")
      .all();
    const turns = histories.map((turn) => {
      const matching = rows
        .filter((row) => typeof turn.sessionId === "string" && row.session_id === turn.sessionId)
        .map((row) => ({ ...row, event: JSON.parse(row.event_json) }))
        .filter(
          (row) =>
            row.event?.message?.role === "assistant" &&
            messageText(row.event.message).trim() === turn.expected,
        );
      return {
        ...turn,
        persistedCount: matching.length,
        persistedSessionId: matching[0]?.session_id,
        persistedSha256: matching[0]
          ? createHash("sha256").update(matching[0].event_json).digest("hex")
          : null,
      };
    });
    const passed =
      turns.length === 8 &&
      turns.every(
        (turn) =>
          turn.rpcHistoryMatches &&
          turn.streamMatches &&
          turn.finalMatches &&
          turn.finalEventCount === 1 &&
          turn.persistedCount === 1 &&
          (!turn.toolExpected || (turn.toolCalls === 1 && turn.toolResults === 1)),
      );
    const evidence = {
      provider: "openai",
      model: liveModel,
      credentialSource: "runner repository secret OPENAI_API_KEY",
      stateRoot: root,
      databasePath,
      configuredAgent,
      turns,
      passed,
      observedCompletions: turns.filter((turn) => turn.rpcHistoryMatches).length,
      transportCounts: fs.existsSync(process.env.OPENCLAW_PERF_HTTP_COUNTS_PATH)
        ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_PERF_HTTP_COUNTS_PATH, "utf8"))
        : { unavailable: "Gateway did not flush transport counts" },
      requestCount: null,
      requestCountNote: "Direct provider request count is not independently observed.",
      fixtureDifferences: [
        "Live OpenAI Responses API",
        toolFlow ? "Two bounded synthetic-file read tool turns" : "Tools denied",
        "Dreaming disabled to bound background inference",
        "128 output-token cap",
      ],
      evidenceNote: `Independent read-only SQLite verification ${checkpoint}. Allocation comparison requires identical fixed-workload counts, collector, source identity, runtime, and host.`,
    };
    if (!passed)
      console.error("Live turn/transcript assertions failed; inspect sanitized result evidence");
    return evidence;
  } finally {
    db.close();
  }
}
