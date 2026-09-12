import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const directory = "qa/.gateway-memory-live";
const canonical = fs
  .readFileSync("scripts/bench-gateway-concurrency.ts", "utf8")
  .replaceAll("\r\n", "\n");
let adapted = canonical
  .replaceAll('from "../packages/', 'from "../../packages/')
  .replaceAll('from "./', 'from "../../scripts/');
const once = (before, after) => {
  if (adapted.split(before).length !== 2)
    throw new Error(`Expected one current-source adaptation anchor: ${before.slice(0, 100)}`);
  adapted = adapted.replace(before, after);
};
adapted = `import { acceptedTurns, livePrompt, configureLive, verifyLiveAgent, captureLiveEvent, requireLiveBudget, captureLiveHistories, finishLiveProof, recordMeasuredLiveProof, selectLiveCleanupSessionKeys } from './live-evidence.mjs';\nimport { registerLiveGateway, ensureLiveGatewayStopped, assertLiveGatewayStopped } from './live-cleanup.mjs';\nimport { connectAllocationProfiler } from './allocation-profiler.mjs';\n${adapted}`;
once(
  '  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });',
  "  configureLive(config, root, concurrency);",
);
once('    utilityModel: "openai/gpt-5.6-luna",', "");
const mockStart = adapted.indexOf("      mockProvider = spawn(");
const mockEnd = adapted.indexOf("      if (options.cpuProfDir)", mockStart);
if (mockStart < 0 || mockEnd < 0) throw new Error("Mock lifecycle anchor missing");
adapted = adapted.slice(0, mockStart) + adapted.slice(mockEnd);
once(
  "  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);",
  "  const [port, mockPort, inspectorPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);",
);
once(
  "  let gateway: ChildProcess | undefined;",
  '  let gateway: ChildProcess | undefined;\n  let profiler;\n  const allocationPhases = {};\n  const supportedCleanup = process.env.OPENCLAW_PERF_SUPPORTED_CLEANUP !== "0";\n  const cleanupProof = { mode: supportedCleanup ? "supported-session-deletion" : "allocation-only", intendedDeletes: supportedCleanup ? options.sessionCount - options.concurrency : 0, completedDeletes: 0, passed: supportedCleanup ? false : null, error: null, durationMs: 0 };',
);
once(
  "      const gatewayArgs = buildGatewayBenchChildArgs(options.entry, port);",
  "      const gatewayArgs = buildGatewayBenchChildArgs(options.entry, port, [`--inspect=127.0.0.1:${inspectorPort}`, '--import', new URL('./live-http-counts.mjs', import.meta.url).href, '--import', new URL('../../scripts/lib/gateway-bench-heap-preload.ts', import.meta.url).href]);",
);
once(
  '          stdio: heapProfilePath ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],',
  '          stdio: ["pipe", "pipe", "pipe", "ipc"],',
);
once(
  '            OPENAI_API_KEY: "gateway-concurrency-benchmark",',
  "            OPENAI_API_KEY: process.env.OPENAI_API_KEY,",
);
once(
  '                OPENCLAW_SKIP_CHANNELS: "1",',
  '                OPENCLAW_SKIP_CHANNELS: "1",\n                OPENCLAW_PERF_HTTP_COUNTS_PATH: process.env.OPENCLAW_PERF_HTTP_COUNTS_PATH,',
);
once(
  "      const rpc = client.request;",
  "      const rpc = client.request;\n      await verifyLiveAgent(rpc);",
);
once(
  "    url: `ws://127.0.0.1:${port}`,",
  "    url: `ws://127.0.0.1:${port}`,\n    onEvent: subscribeSessions ? captureLiveEvent : undefined,",
);
once("      : `Reply with benchmark stream ${index + 1}.`,", "      : livePrompt(index),");
once(
  "  options?.onStarted?.();",
  "  acceptedTurns.push({ runId: started.runId ?? requestedRunId, sessionKey: options?.sessionKey ?? `agent:main:gateway-concurrency-${index + 1}`, expected: `LIVE_GATEWAY_OK_${index + 1}` });\n  options?.onStarted?.();",
);
once(
  "      const sessionSeedStartedAt = performance.now();",
  "      profiler = await connectAllocationProfiler(inspectorPort, process.env.OPENCLAW_PERF_PROFILE_DIR, gateway);\n      await profiler.snapshot('warmup');\n      await profiler.start('seed');\n      const sessionSeedStartedAt = performance.now();",
);
once(
  "      const sessionSeedDurationMs = performance.now() - sessionSeedStartedAt;",
  "      const sessionSeedDurationMs = performance.now() - sessionSeedStartedAt;\n      allocationPhases.seed = await profiler.stop();\n      await profiler.snapshot('seed');",
);
once(
  "      const loadStartMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);",
  "      await profiler.start('load');\n      const loadStartMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);",
);
once(
  "      const loadEndMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);",
  "      const loadEndMonotonicMicros = Number(process.hrtime.bigint() / 1_000n);\n      allocationPhases.load = await profiler.stop();\n      await profiler.snapshot('load');\n      if (readyz.length !== 100 || history.length !== 1200 || sessionUpdates.length !== 100) throw new Error('Fixed workload count mismatch');\n      if ([freshConnectionResult, ...readyz, ...controlUi, ...history, ...sessionUpdates, ...sessionsList, ...controlPlane, ...messageSubscriptionsDuringLoad].some((probe) => !probe.ok)) throw new Error('Fixed workload contains failed probes');",
);
once(
  "      const memoryAfter = await readGatewayMemory(rpc, runStartedAt);",
  "      await captureLiveHistories(rpc);\n      recordMeasuredLiveProof(root);\n      const memoryAfter = await readGatewayMemory(rpc, runStartedAt);",
);
once(
  "      gatewayProcess: readGatewayProcess(),",
  "      gatewayProcess: readGatewayProcess(),\n      allocationPhases,\n      cleanupProof,\n      liveProof: finishLiveProof(root),",
);
once(
  "  const options = parseOptions(argv);",
  "  const options = parseOptions(argv);\n  requireLiveBudget(options);",
);
once('    mode: "mock-streaming-agent",', '    mode: "live-openai-allocation-gateway",');
once(
  "  if (payload.summary.budgetViolations.length > 0) {",
  '  if (runs.some((run) => !run.liveProof?.passed)) throw new Error("Live response/transcript proof failed");\n  if (runs.some((run) => run.gatewayExit?.exitCode !== 0 || run.gatewayExit?.signal !== null)) throw new Error("Live Gateway did not exit cleanly");\n  if (runs.some((run) => run.cleanupProof.error || (run.cleanupProof.mode !== "allocation-only" && !run.cleanupProof.passed))) throw new Error("Cleanup or evidence capture failed; see recorded counts");\n  if (payload.summary.budgetViolations.length > 0) {',
);
once(
  '      gateway.once("exit", (exitCode, signal) => {',
  '      registerLiveGateway(gateway, root);\n      console.error(JSON.stringify({ evidence: "gateway-owned", pid: gateway.pid, root, configPath, port, inspectorPort, start: new Date().toISOString() }));\n      gateway.once("exit", (exitCode, signal) => {',
);
once(
  "      for (const auxiliaryClient of auxiliaryClients) {\n        auxiliaryClient.close();",
  "      for (const auxiliaryClient of auxiliaryClients) {\n        auxiliaryClient.close();",
);
once(
  "      client?.close();",
  `      client?.close();
      const cleanupStartedAt = performance.now();
      try { if (profiler && result) {
        writeFileSync(path.join(process.env.OPENCLAW_PERF_PROFILE_DIR, 'measured-workload.json'), JSON.stringify({result, allocationPhases}, null, 2), {mode: 0o600});
        if (supportedCleanup) {
        await delay(3000);
        await profiler.snapshot('disconnected-idle');
        const cleanupClient = await connectGateway(port, performance.now() + 1200000, protocolVersion, false);
        try {
          for (const key of selectLiveCleanupSessionKeys(options.sessionCount, acceptedTurns)) {
            const deletion = await cleanupClient.request('sessions.delete', {key, deleteTranscript: true});
            if (!deletion?.deleted) throw new Error('Owned synthetic session cleanup did not delete expected session');
            cleanupProof.completedDeletes++;
            if (cleanupProof.completedDeletes % 100 === 0) console.error(JSON.stringify({evidence: 'supported-cleanup-progress', completedDeletes: cleanupProof.completedDeletes}));
          }
        } finally { cleanupClient.close(); }
        await delay(3000);
        await profiler.snapshot('supported-cleanup');
        cleanupProof.passed = true;
        }
      } } catch (error) {
        cleanupProof.error = error instanceof Error ? error.name : 'Unknown cleanup failure';
      } finally {
        cleanupProof.durationMs = performance.now() - cleanupStartedAt;
        profiler?.close();
      }`,
);
once(
  "        gatewayExit = await stopChild(gateway);",
  "        gatewayExit = await stopChild(gateway);\n        await ensureLiveGatewayStopped();\n        assertLiveGatewayStopped();",
);
once(
  "      rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });",
  "      assertLiveGatewayStopped();\n      rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });",
);
adapted = adapted.replaceAll("modelRequestCount", "unobservedModelRequestCount");
fs.writeFileSync(`${directory}/live-bench.ts`, adapted);
execFileSync("node_modules/.bin/oxfmt", ["--write", `${directory}/live-bench.ts`], {
  stdio: "inherit",
});
const formattedAdapter = fs.readFileSync(`${directory}/live-bench.ts`, "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const helpers = Object.fromEntries(
  ["gateway-bench-heap.ts", "gateway-bench-heap-preload.ts"].map((name) => [
    name,
    sha256(fs.readFileSync(`scripts/lib/${name}`)),
  ]),
);
fs.writeFileSync(
  `${directory}/adapter-source.json`,
  JSON.stringify(
    {
      sourceCommit: git("rev-parse", "HEAD"),
      sourceTree: git("rev-parse", "HEAD^{tree}"),
      sourceDiffSha256: sha256(git("diff", "--binary", "HEAD")),
      canonicalSha256: sha256(canonical),
      adapterSha256: sha256(formattedAdapter),
      canonical: "scripts/bench-gateway-concurrency.ts",
      heapCollector: { owner: "scripts/lib", commit: git("rev-parse", "HEAD"), helpers },
      workload: { sessions: 1000, liveTurns: 8, patches: 100, samples: 100, historyRequests: 1200 },
    },
    null,
    2,
  ),
);
console.log("Prepared current-source live allocation adapter");
