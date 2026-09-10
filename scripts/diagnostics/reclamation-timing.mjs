import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const expectedHead = "3baf393d5bb9acfe62e01e023ec5ef0543de1f8d";
const backupRoot = path.join(process.env.RUNNER_TEMP, "reclamation-diagnostic-inputs");
const channelName = "openclaw.pr138579.reclamation-diagnostic";
const root = process.cwd();
const mode = process.argv[2] ?? "--check";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });

if (mode === "--restore") {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
  if (manifest.root !== root || manifest.expectedHead !== expectedHead) {
    throw new Error("Backup belongs to a different checkout or diagnostic input");
  }
  for (const entry of manifest.files) {
    const original = fs.readFileSync(path.join(backupRoot, entry.file));
    const current = fs.readFileSync(path.join(root, entry.file));
    if (sha256(original) !== entry.originalSha256) {
      throw new Error(`Backup changed: ${entry.file}`);
    }
    if (![entry.originalSha256, entry.instrumentedSha256].includes(sha256(current))) {
      throw new Error(`Refusing to overwrite unrecognized changes: ${entry.file}`);
    }
  }
  for (const entry of manifest.files) {
    fs.copyFileSync(path.join(backupRoot, entry.file), path.join(root, entry.file));
    if (sha256(fs.readFileSync(path.join(root, entry.file))) !== entry.originalSha256) {
      throw new Error(`Restore verification failed: ${entry.file}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({ restored: manifest.files.map((entry) => entry.file), backupRoot })}\n`,
  );
  process.exit(0);
}

if (!["--check", "--check-source", "--apply"].includes(mode)) {
  throw new Error("Use --check, --check-source, --apply, or --restore");
}
if (mode !== "--check-source" && git("rev-parse", "HEAD").trim() !== expectedHead) {
  throw new Error(`Diagnostic requires exact tested merge ${expectedHead}`);
}
if (fs.existsSync(backupRoot)) {
  throw new Error(`Refusing an existing diagnostic backup: ${backupRoot}`);
}

const changes = new Map();
function edit(file, replacements) {
  const expected = git("show", `${expectedHead}:${file}`);
  const original =
    mode === "--check-source" ? expected : fs.readFileSync(path.join(root, file), "utf8");
  if (original !== expected) {
    throw new Error(`Input differs from tested merge: ${file}`);
  }
  let content = original;
  for (const [label, before, after] of replacements) {
    const parts = content.split(before);
    if (parts.length !== 2) {
      throw new Error(`${file}: ${label} expected one exact site, found ${parts.length - 1}`);
    }
    content = parts.join(after);
  }
  changes.set(file, { original, content });
}

const diagnosticImport =
  'import { channel as reclamationDiagnosticChannel } from "node:diagnostics_channel";\n';
const publish = (phase, extra = "") =>
  `reclamationDiagnosticChannel(${JSON.stringify(channelName)}).publish({ phase: ${JSON.stringify(phase)}${extra} });`;

edit("src/gateway/server.sessions.reclamation.test.ts", [
  [
    "diagnostic imports",
    'import { performance } from "node:perf_hooks";',
    `${diagnosticImport}import { performance, PerformanceObserver } from "node:perf_hooks";`,
  ],
  [
    "diagnostic failure cleanup",
    "afterEach(() => {\n  closeOpenClawAgentDatabasesForTest();",
    "let finishReclamationDiagnostic: (() => void) | undefined;\n\nafterEach(() => {\n  finishReclamationDiagnostic?.();\n  finishReclamationDiagnostic = undefined;\n  closeOpenClawAgentDatabasesForTest();",
  ],
  [
    "buffered observation setup",
    "  const samples: number[] = [];\n  let previous = performance.now();",
    `  // #region debug log pr138579-reclamation-phase
  const diagnosticEvents: Array<{ atMs: number; event: unknown }> = [];
  const diagnosticSamples: Array<{ startMs: number; endMs: number; phase: unknown }> = [];
  const diagnosticGc: object[] = [];
  const diagnosticChannel = reclamationDiagnosticChannel(${JSON.stringify(channelName)});
  let diagnosticPhase: unknown = { phase: "measurement-start" };
  const onDiagnostic = (event: unknown) => {
    diagnosticPhase = event;
    diagnosticEvents.push({ atMs: performance.now(), event });
  };
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) diagnosticGc.push(entry.toJSON());
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  diagnosticChannel.subscribe(onDiagnostic);
  const samples: number[] = [];
  let previous = performance.now();
  const diagnosticStartedAt = previous;`,
  ],
  [
    "interval samples",
    "    samples.push(current - previous);\n    previous = current;",
    "    samples.push(current - previous);\n    diagnosticSamples.push({ startMs: previous, endMs: current, phase: diagnosticPhase });\n    previous = current;",
  ],
  [
    "open client observation and flush owner",
    "  }, 10);\n  const { ws } = await openClient();",
    `  }, 10);
  let diagnosticFinished = false;
  finishReclamationDiagnostic = () => {
    if (diagnosticFinished) return;
    diagnosticFinished = true;
    clearInterval(heartbeat);
    const diagnosticFinishedAt = performance.now();
    for (const entry of gcObserver.takeRecords()) diagnosticGc.push(entry.toJSON());
    gcObserver.disconnect();
    diagnosticChannel.unsubscribe(onDiagnostic);
    process.stdout.write(JSON.stringify({
      diagnostic: "pr138579-reclamation-phase",
      timeOrigin: performance.timeOrigin,
      startedAtMs: diagnosticStartedAt,
      finishedAtMs: diagnosticFinishedAt,
      events: diagnosticEvents,
      samples: diagnosticSamples,
      gc: diagnosticGc,
    }) + "\\n");
  };
  ${publish("open-client-start")}
  const { ws } = await openClient();
  ${publish("open-client-end")}
  // #endregion debug log pr138579-reclamation-phase`,
  ],
  [
    "existing pre-delete wait",
    "    const deleteStartedAt = performance.now();",
    `    ${publish("delete-rpc-start")}
    const deleteStartedAt = performance.now();`,
  ],
  [
    "RPC completion",
    "    deleteMs = performance.now() - deleteStartedAt;\n  } finally {\n    clearInterval(heartbeat);\n    ws.close();",
    `    deleteMs = performance.now() - deleteStartedAt;
    ${publish("delete-rpc-end")}
  } finally {
    clearInterval(heartbeat);
    ws.close();
    finishReclamationDiagnostic();`,
  ],
]);

edit("src/gateway/test-helpers.server.ts", [
  [
    "diagnostic import",
    'import fs from "node:fs/promises";',
    `${diagnosticImport}import fs from "node:fs/promises";`,
  ],
  [
    "prepared runtime start",
    '  const config = publishGatewayTestConfig(options?.config);\n  const preparedRuntime = await import("../agents/prepared-model-runtime.js");',
    `  ${publish("prepared-runtime-start")}
  const config = publishGatewayTestConfig(options?.config);
  const preparedRuntime = await import("../agents/prepared-model-runtime.js");
  ${publish("prepared-runtime-import-end")}`,
  ],
  [
    "prepared runtime end",
    "  gatewayReplyRuntimePrepared = true;\n}",
    `  gatewayReplyRuntimePrepared = true;
  ${publish("prepared-runtime-end")}
}`,
  ],
]);

edit("src/gateway/server.e2e-ws-harness.ts", [
  [
    "diagnostic import",
    'import { WebSocket } from "ws";',
    `${diagnosticImport}import { WebSocket } from "ws";`,
  ],
  [
    "socket open start",
    "    const ws = new WebSocket(\n      `ws://127.0.0.1:${port}`,",
    `    ${publish("websocket-open-start")}
    const ws = new WebSocket(
      \`ws://127.0.0.1:\${port}\`,`,
  ],
  [
    "connect start and end",
    "      const hello = await connectOk(ws, opts);\n      return { ws, hello };",
    `      ${publish("websocket-open-end")}
      ${publish("connect-protocol-start")}
      const hello = await connectOk(ws, opts);
      ${publish("connect-protocol-end")}
      return { ws, hello };`,
  ],
]);

edit("src/config/sessions/session-accessor.sqlite-reclamation-commit.ts", [
  [
    "diagnostic import",
    'import { AsyncLocalStorage } from "node:async_hooks";',
    `${diagnosticImport}import { AsyncLocalStorage } from "node:async_hooks";`,
  ],
  [
    "authorization start",
    "): unknown[] {\n  const shared = new Int32Array(buffer);\n  // The Worker owns",
    `): unknown[] {
  const shared = new Int32Array(buffer);
  ${publish("parent-authorize-start", ", state: Atomics.load(shared, 0)")}
  // The Worker owns`,
  ],
  [
    "native database open boundaries",
    "    database = openNodeSqliteDatabase(databasePath);\n    setSqliteBusyTimeout(database, COMMIT_DECISION_TIMEOUT_MS);",
    `    ${publish("parent-database-open-start")}
    database = openNodeSqliteDatabase(databasePath);
    ${publish("parent-database-open-end")}
    setSqliteBusyTimeout(database, COMMIT_DECISION_TIMEOUT_MS);`,
  ],
  [
    "authority check boundary",
    "    assertCurrent();\n    if (Atomics.compareExchange(shared, 0, REQUESTED, APPROVED) !== REQUESTED) {",
    `    ${publish("parent-authority-check-start")}
    assertCurrent();
    ${publish("parent-authority-check-end")}
    if (Atomics.compareExchange(shared, 0, REQUESTED, APPROVED) !== REQUESTED) {`,
  ],
  [
    "approved signal",
    "    Atomics.notify(shared, 0);\n\n    while (!settled) {",
    `    Atomics.notify(shared, 0);
    ${publish("parent-worker-approved", ", state: Atomics.load(shared, 0)")}

    while (!settled) {`,
  ],
  [
    "settled shared-state observation",
    "      if (Atomics.load(shared, 0) === SETTLED) {\n        settled = true;",
    `      if (Atomics.load(shared, 0) === SETTLED) {
        ${publish("parent-observed-worker-settled", ", state: Atomics.load(shared, 0)")}
        settled = true;`,
  ],
  [
    "blocking transaction boundaries",
    "        runSqliteImmediateTransactionSync(database, () => {\n          settled = true;\n        });",
    `        ${publish("parent-settlement-transaction-start", ", state: Atomics.load(shared, 0)")}
        try {
          runSqliteImmediateTransactionSync(database, () => {
            ${publish("parent-settlement-writer-lock-acquired", ", state: Atomics.load(shared, 0)")}
            settled = true;
          });
        } finally {
          ${publish("parent-settlement-transaction-end", ", settled, state: Atomics.load(shared, 0)")}
        }`,
  ],
  [
    "authorization final cleanup",
    "    } catch (error) {\n      // The original authorization failure stays fatal. After settlement, the\n      // Worker's result owns success and all postcommit publication must continue.\n      if (settled) {\n        recoveredErrors.push(error);\n      }\n    }\n  }\n  return recoveredErrors;",
    `    } catch (error) {
      // The original authorization failure stays fatal. After settlement, the
      // Worker's result owns success and all postcommit publication must continue.
      if (settled) {
        recoveredErrors.push(error);
      }
    } finally {
      ${publish("parent-authorize-end", ", settled, state: Atomics.load(shared, 0)")}
    }
  }
  return recoveredErrors;`,
  ],
]);

const test = changes.get("src/gateway/server.sessions.reclamation.test.ts").content;
for (const required of [
  "const ROWS = 200_000;",
  "expect(maxGatewayGapMs).toBeLessThan(500);",
  "}, 120_000);",
  "setTimeout(resolve, 25);",
  'deleted = await rpcReq(ws, "sessions.delete", { key: SESSION_KEY }, 60_000);',
]) {
  if (!test.includes(required)) throw new Error(`Original test contract missing: ${required}`);
}
const manifest = {
  root,
  expectedHead,
  channelName,
  files: [...changes].map(([file, value]) => ({
    file,
    originalSha256: sha256(value.original),
    instrumentedSha256: sha256(value.content),
  })),
};
if (mode === "--check" || mode === "--check-source") {
  process.stdout.write(`${JSON.stringify({ checked: true, ...manifest }, null, 2)}\n`);
  process.exit(0);
}

fs.mkdirSync(backupRoot);
for (const [file, value] of changes) {
  const destination = path.join(backupRoot, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, value.original, { flag: "wx" });
}
fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
});
for (const [file, value] of changes) {
  fs.writeFileSync(path.join(root, file), value.content);
}
for (const entry of manifest.files) {
  if (sha256(fs.readFileSync(path.join(root, entry.file))) !== entry.instrumentedSha256) {
    throw new Error(`Instrumented verification failed: ${entry.file}; restore from ${backupRoot}`);
  }
}
process.stdout.write(
  `${JSON.stringify({ applied: manifest.files.map((entry) => entry.file), backupRoot })}\n`,
);
