import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectManagedProcessGroup,
  runManagedCommand,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { assertReliabilityForcedExit } from "../../scripts/lib/sqlite-reliability-process.js";
import { findVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { waitForDead } from "../../test/helpers/process-wait.js";
import type { ManagedUpdateLeaseAuthority } from "../cli/update-cli/update-command-executor.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const EVENT_PREFIX = "OPENCLAW_ACTIVATION_TEST ";
const CHILD_TIMEOUT_MS = 60_000;

async function captureCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) {
  let stdout = "";
  let stderr = "";
  const abort = new AbortController();
  assert.ok(
    findVitestResourceOwner(options.env.TMPDIR),
    "activation commands require a parent-owned custody registry",
  );
  const code = await runManagedCommand({
    bin: command,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeout,
    timeoutKillGraceMs: 500,
    timeoutForceKillOnLeaderExit: true,
    requireProcessTreeExit: true,
    signal: abort.signal,
    stdio: ["ignore", "pipe", "pipe"],
    onReady(child) {
      child.stdout?.on("data", (bytes: Buffer) => {
        stdout += bytes.toString();
        if (stdout.length + stderr.length > 4 * 1024 * 1024) abort.abort();
      });
      child.stderr?.on("data", (bytes: Buffer) => {
        stderr += bytes.toString();
        if (stdout.length + stderr.length > 4 * 1024 * 1024) abort.abort();
      });
    },
  });
  if (code !== 0) {
    throw Object.assign(new Error(`${command} exited ${code}`), { code, stdout, stderr });
  }
  return { stdout, stderr };
}

export type ActivationFault = {
  label: string;
  operation: "rename" | "remove" | "unlink" | "rmdir" | "copy" | "symlink";
  path: string;
  argument?: 0 | 1;
  descendants?: boolean;
  basename?: string;
  postCore?: boolean;
  when: "before" | "after";
  occurrence?: number;
  action?: "error" | "observe";
};

type ProcessEvent = {
  event: string;
  pid: number;
  parentPid?: number;
  label?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  startIdentity?: number;
  detached?: boolean;
  fd3?: boolean;
  fenced?: boolean;
};

export type ActivationProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export function activationEnvironment(base: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, "home"),
    TMPDIR: path.join(base, "tmp"),
    LC_ALL: "C",
    TZ: "UTC",
    OPENCLAW_STATE_DIR: path.join(base, "state"),
    OPENCLAW_CONFIG_PATH: path.join(base, "state", "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    npm_config_cache: path.join(base, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

export async function activationCommand(
  command: string,
  args: string[],
  base: string,
  timeout = CHILD_TIMEOUT_MS,
) {
  return await captureCommand(command, args, {
    cwd: base,
    env: activationEnvironment(base),
    timeout,
  });
}

export async function createActivationFixture(
  base: string,
  preload: string,
  target: "capable" | "legacy" | "respawn-only" = "capable",
  receiver: "complete" | "hold" | "descendant" = "complete",
) {
  const prefix = path.join(base, "prefix");
  const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
  const binDir = path.join(prefix, "bin");
  await Promise.all(
    ["home", "tmp", "state", "packages"].map((name) =>
      fs.mkdir(path.join(base, name), { recursive: true }),
    ),
  );
  const tarballs: string[] = [];
  for (const version of ["1.0.0", "2.0.0"]) {
    const root = path.join(base, "packages", version);
    const entrypoints = [`openclaw-${version}.mjs`, `helper-${version}.mjs`];
    await writePackageRoot(root, version);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        type: "module",
        bin: { openclaw: entrypoints[0], "openclaw.helper": entrypoints[1] },
      }),
    );
    for (const name of entrypoints) {
      await fs.writeFile(
        path.join(root, name),
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${name}:${version}\n`)});\n`,
        { mode: 0o755 },
      );
    }
    const receiverSource = `import { runActivationReceiver } from ${JSON.stringify(import.meta.url)};
await runActivationReceiver(${JSON.stringify({ base, receiver, legacy: target !== "capable" })});
`;
    await fs.writeFile(path.join(root, "dist", "index.js"), receiverSource);
    const checkPath = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    await fs.mkdir(path.dirname(checkPath), { recursive: true });
    await fs.writeFile(
      checkPath,
      target === "legacy"
        ? 'process.stdout.write("{}");\n'
        : `await import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
    );
    if (target === "respawn-only") {
      await fs.rename(path.join(root, "dist", "index.js"), path.join(root, "dist", "receiver.mjs"));
      await fs.writeFile(
        path.join(root, "dist", "entry.mjs"),
        `import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, [fileURLToPath(new URL("./receiver.mjs", import.meta.url))], { stdio: "inherit" });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
`,
      );
    }
    await writePackageDistInventory(root);
    const packed = await activationCommand(
      "npm",
      ["pack", root, "--pack-destination", base, "--ignore-scripts", "--json", "--loglevel=error"],
      base,
    );
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]?.filename;
    assert.ok(filename, "npm pack did not identify its tarball");
    tarballs.push(path.join(base, filename));
  }
  await activationCommand(
    "npm",
    ["install", "--global", "--prefix", prefix, tarballs[0]!, "--no-fund", "--no-audit"],
    base,
  );
  const sentinel = path.join(binDir, "unrelated-tool");
  await fs.writeFile(sentinel, "unrelated executable\n", { mode: 0o755 });
  return {
    base,
    preload,
    target,
    prefix,
    packageRoot,
    globalRoot: path.dirname(packageRoot),
    binDir,
    launcher: path.join(binDir, "openclaw"),
    secondLauncher: path.join(binDir, "openclaw.helper"),
    sentinel,
    candidateTarball: tarballs[1]!,
    beforeVersion: "1.0.0",
    afterVersion: "2.0.0",
    databasePath: path.join(base, "authority", "managed-update-handoffs.sqlite"),
  };
}

export type ActivationFixture = Awaited<ReturnType<typeof createActivationFixture>>;

// Each ancestor stays alive until explicitly killed. Its child exit event proves
// reaping before the next ancestor dies; the test process is never in this group.
const ancestorSource = `
const { spawn } = require("node:child_process");
const [encoded, source] = process.argv.slice(1);
const options = JSON.parse(encoded);
const args = options.depth > 1
  ? ["-e", source, JSON.stringify({ ...options, depth: options.depth - 1 }), source]
  : options.args;
const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
const emit = value => process.stdout.write("OPENCLAW_ACTIVATION_TEST " + JSON.stringify(value) + "\\n");
emit({ event: "spawned", pid: child.pid, parentPid: process.pid });
child.once("error", error => { throw error; });
child.once("exit", (code, signal) => emit({ event: "reaped", pid: child.pid, code, signal }));
setInterval(() => {}, 1000);
`;

export function startActivationProcess(params: {
  base: string;
  args: string[];
  preload?: string;
  faults?: ActivationFault[];
  ancestors?: boolean;
  observeChildren?: boolean;
  childFault?: "spawn" | "early-exit" | "closed-pipe";
  env?: NodeJS.ProcessEnv;
}) {
  const events: ProcessEvent[] = [];
  const changes = new EventEmitter();
  const identities = new Map<number, number>();
  let stdout = "";
  let stderr = "";
  const buffers = { stdout: "", stderr: "" };
  const groups = new Set<number>();
  if (params.faults?.length || params.observeChildren) {
    assert.ok(params.preload, "filesystem checkpoints require the source fixture preload");
  }
  const args = [
    ...(params.faults?.length || params.observeChildren ? ["--import", params.preload!] : []),
    ...params.args,
  ];
  const child = spawn(
    process.execPath,
    params.ancestors
      ? ["-e", ancestorSource, JSON.stringify({ args, depth: 2 }), ancestorSource]
      : args,
    {
      cwd: params.base,
      env: {
        ...activationEnvironment(params.base),
        ...params.env,
        ...(params.faults?.length
          ? { OPENCLAW_ACTIVATION_TEST_FAULTS: JSON.stringify(params.faults) }
          : {}),
        ...(params.observeChildren
          ? {
              NODE_OPTIONS: `--import ${JSON.stringify(params.preload)}`,
              OPENCLAW_ACTIVATION_TEST_OBSERVE_CHILDREN: "1",
              OPENCLAW_ACTIVATION_TEST_CHILD_FAULT: params.childFault,
            }
          : {}),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  function recordIdentity(pid: number, observed?: number) {
    const identity = observed ?? getFileLockProcessStartTime(pid);
    assert.notEqual(identity, null, `fixture process ${pid} has no start identity`);
    identities.set(pid, identity!);
  }
  assert.ok(child.pid, "fixture process did not spawn");
  recordIdentity(child.pid);
  groups.add(child.pid);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const consume = (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stdout") stdout += chunk;
    else stderr += chunk;
    buffers[stream] += chunk;
    let newline: number;
    while ((newline = buffers[stream].indexOf("\n")) >= 0) {
      const line = buffers[stream].slice(0, newline);
      buffers[stream] = buffers[stream].slice(newline + 1);
      if (!line.startsWith(EVENT_PREFIX)) {
        continue;
      }
      const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as ProcessEvent;
      if (event.event === "spawned") {
        recordIdentity(event.pid, event.startIdentity);
        if (event.detached) groups.add(event.pid);
      }
      events.push(event);
      changes.emit("change");
    }
  };
  child.stdout.on("data", (chunk: string) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: string) => consume("stderr", chunk));
  const rawClosed = new Promise<ActivationProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
      changes.emit("change");
    });
  });
  const closed = bounded(rawClosed, CHILD_TIMEOUT_MS, "activation process/output close");
  void closed.catch(() => {});

  async function waitFor(
    predicate: (event: ProcessEvent) => boolean,
    description: string,
  ): Promise<ProcessEvent> {
    const found = events.find(predicate);
    if (found) {
      return found;
    }
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        changes.off("change", check);
      };
      const check = () => {
        const event = events.find(predicate);
        if (event) {
          cleanup();
          resolve(event);
        } else if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          events.some(
            (entry) =>
              entry.event === "reaped" &&
              entry.code !== null &&
              !events.some(
                (spawned) =>
                  spawned.event === "spawned" &&
                  spawned.pid === entry.pid &&
                  spawned.fd3 !== undefined,
              ),
          )
        ) {
          cleanup();
          reject(new Error(`fixture closed before ${description}\n${stdout}\n${stderr}`));
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${description}\n${stdout}\n${stderr}`));
      }, CHILD_TIMEOUT_MS);
      changes.on("change", check);
      check();
    });
  }

  function signal(pid: number) {
    assert.equal(
      getFileLockProcessStartTime(pid),
      identities.get(pid),
      `refusing to signal changed fixture process ${pid}`,
    );
    process.kill(pid, "SIGKILL");
  }

  async function killPid(pid: number) {
    if (!isPidAlive(pid)) return;
    signal(pid);
    await waitForDead(pid, 5_000);
  }

  const group = (pid: number) => ({
    pid,
    exitCode: isPidAlive(pid) ? null : 1,
    signalCode: null,
  });
  async function join() {
    await bounded(
      Promise.all([
        rawClosed,
        ...[...groups].map(async (pid) => {
          await waitForManagedProcessGroupExit(group(pid), 5_000, { errorPolicy: "indeterminate" });
          assert.equal(
            inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" }),
            "dead",
          );
        }),
      ]),
      6_000,
      "activation process, group, and output join",
    );
  }

  async function killAndJoin() {
    // Reverse spawn order preserves a live reaper for every killed descendant.
    for (const pid of [...identities.keys()].toReversed()) {
      if (!isPidAlive(pid)) continue;
      if (pid === child.pid) {
        signal(pid);
        await waitForDead(pid, 5_000);
      } else {
        signal(pid);
        const reaped = await waitFor(
          (event) => event.event === "reaped" && event.pid === pid,
          `fixture process ${pid} reap`,
        );
        assertReliabilityForcedExit(
          { code: reaped.code ?? null, signal: reaped.signal ?? null },
          "activation fixture worker",
        );
      }
      await waitForDead(pid, 5_000);
    }
    await join();
    assertReliabilityForcedExit(await rawClosed, "activation fixture ancestor");
  }

  async function cleanup() {
    const errors: unknown[] = [];
    for (const pid of [...groups].toReversed()) {
      try {
        const state = inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" });
        if (state === "dead") continue;
        assert.equal(state, "live", "fixture process group ownership is unknown");
        if (isPidAlive(pid)) {
          assert.equal(getFileLockProcessStartTime(pid), identities.get(pid));
        }
        terminateManagedChild(
          { ...group(pid), kill: (signal) => process.kill(pid, signal) },
          "SIGKILL",
          { processGroupFallback: "never" },
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await join();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Activation fixture cleanup remains pending");
  }

  return {
    child,
    closed,
    cleanup,
    killAndJoin,
    killPid,
    join,
    pids: () => [...identities.keys()],
    events: () => [...events],
    output: () => ({ stdout, stderr }),
    checkpoint: (label: string) =>
      waitFor((event) => event.event === "checkpoint" && event.label === label, label),
    event: (name: string) => waitFor((event) => event.event === name, name),
  };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function activationSourceArgs(fixture: ActivationFixture, mode = "update"): string[] {
  const entry = fileURLToPath(import.meta.url);
  assert.equal(path.extname(entry), ".js", "activation children require the invocation compiler");
  return [entry, mode, JSON.stringify(fixture)];
}

export type ActivationDriverCustodyFixture = {
  base: string;
  mode: "before-grant" | "after-grant" | "refused";
  runId: string;
  packages: Awaited<ReturnType<typeof createPackageSwapFixture>>;
  authority: Omit<ManagedUpdateLeaseAuthority, "owner">;
};

export function activationDriverCustodyArgs(fixture: ActivationDriverCustodyFixture): string[] {
  // Parent and receiver share the invocation graph; source-loading swap would
  // reject the unbuilt sealed helper before reaching the fd3 owner boundary.
  const entry = fileURLToPath(import.meta.url);
  assert.equal(path.extname(entry), ".js", "activation children require the invocation compiler");
  return [entry, "driver-custody", JSON.stringify(fixture)];
}

export async function runActivationDriverCustodyReceiver(
  fixture: Pick<ActivationDriverCustodyFixture, "base" | "mode">,
) {
  const { withPostCoreUpdateExecutor } =
    await import("../cli/update-cli/update-command-post-core-executor.js");
  const { getUpdateRun } = await import("./update-run-ledger.js");
  if (fixture.mode === "before-grant") {
    await new Promise<never>(() => setInterval(() => {}, 1000));
  }
  await withPostCoreUpdateExecutor({}, async (opts) => {
    assert.ok(opts.run?.executorFence);
    opts.run.executorFence.assertCurrent();
    fsSync.writeFileSync(
      path.join(fixture.base, "receiver.json"),
      JSON.stringify({
        pid: process.pid,
        run: getUpdateRun(opts.run.runId, { env: process.env }),
      }),
    );
    if (fixture.mode === "after-grant") {
      await new Promise<never>(() => setInterval(() => {}, 1000));
    }
    fsSync.writeFileSync(
      process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH!,
      JSON.stringify({
        status: "ok",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
      }),
    );
  });
}

async function runActivationDriverCustody(fixture: ActivationDriverCustodyFixture) {
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const { continuePostCoreUpdateInFreshProcess } =
    await import("../cli/update-cli/update-command-post-core.js");
  const { swapStagedPackageInstall } = await import("./package-update-swap.js");
  const { createManagedHandoffLeaseStore } =
    await import("./update-managed-service-handoff-lease.js");
  const { createUpdateRun, adoptUpdateRun, getUpdateRun, finishUpdateRun, heartbeatUpdateRun } =
    await import("./update-run-ledger.js");
  const { base, mode, runId, packages, authority } = fixture;
  const stage = packages.params.stage.packageRoot;
  await fs.writeFile(
    path.join(stage, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2.0.0", type: "module" }),
  );
  const worker = runtimeProcessEntrypoints.updateMigratedFinalize;
  const check = path.join(stage, "dist", worker.distWorkerPath);
  await fs.mkdir(path.dirname(check), { recursive: true });
  await fs.writeFile(
    check,
    `await import(${JSON.stringify(resolveRuntimeWorkerUrl(worker).href)});\n`,
  );
  await fs.writeFile(
    path.join(stage, "dist", "index.js"),
    `import { runActivationDriverCustodyReceiver } from ${JSON.stringify(import.meta.url)};
await runActivationDriverCustodyReceiver(${JSON.stringify({ base, mode })});
`,
  );
  await writePackageDistInventory(stage);
  const env = { ...process.env };
  const parent = adoptUpdateRun(createUpdateRun({ runId, trigger: "cli" }, { env }).runId, { env })
    .origin.driver;
  assert.ok(parent, "fixture parent identity unavailable");
  const store = createManagedHandoffLeaseStore({
    databasePath: authority.databasePath,
    serviceManagerEnv: env,
  });
  const nativeSpawn = childProcess.spawn;
  let candidate: ChildProcess | undefined;
  let candidatePipe: Socket | undefined;
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    const child = Reflect.apply(nativeSpawn, childProcess, args) as ChildProcess;
    if (Array.isArray(args[1]) && args[1][1] === "update") {
      candidate = child;
      assert.ok(child.pid);
      fsSync.writeFileSync(
        path.join(base, "spawned.json"),
        JSON.stringify({ pid: child.pid, startIdentity: getFileLockProcessStartTime(child.pid) }),
      );
      const pipe = child.stdio[3];
      assert.ok(pipe instanceof Socket);
      candidatePipe = pipe;
      const nativeEnd = pipe.end;
      pipe.end = function (this: Socket, ...input: Parameters<Socket["end"]>) {
        const grant = JSON.parse(String(input[0])) as { childKey: string };
        const recorded = getUpdateRun(runId, { env });
        const bound = store.read(grant.childKey);
        assert.ok(bound.kind === "current", "bound child missing");
        heartbeatUpdateRun(runId, parent, { env });
        fsSync.writeFileSync(
          path.join(base, "delivery.json"),
          JSON.stringify({
            run: recorded,
            parent,
            bound: bound.lease.executor,
            childKey: grant.childKey,
            renewed: getUpdateRun(runId, { env }),
            bytesWritten: pipe.bytesWritten,
          }),
        );
        if (mode === "before-grant") process.exit(0);
        return Reflect.apply(nativeEnd, this, input);
      } as Socket["end"];
    }
    return child;
  }) as typeof spawn;
  syncBuiltinESMExports();
  await withUpdateCommandExecutor(
    runId,
    async (executor) => {
      const fence = await executor.enter(packages.packageRoot);
      const result = await swapStagedPackageInstall({
        ...packages.params,
        activation: { fence, nodeRunner: process.execPath, onPrepared() {} },
        onTransaction() {},
      });
      assert.equal(result.status, "committed", JSON.stringify(result));
      if (mode === "refused") {
        finishUpdateRun(runId, { status: "failed", reason: "fixture-terminal" }, { env });
      }
      const run = { runId, env: { ...env }, executorFence: fence };
      const work = continuePostCoreUpdateInFreshProcess({
        root: packages.packageRoot,
        channel: "stable",
        requestedChannel: null,
        opts: { json: true, yes: true, restart: false, run },
        pluginInstallRecords: {},
        updateStartedAtMs: Date.now(),
        timeoutMs: 20_000,
        nodeRunner: process.execPath,
      });
      // Preparation awaits must not retarget the captured diagnostic owner.
      run.runId = "00000000-0000-4000-8000-000000000000";
      run.env.OPENCLAW_STATE_DIR = path.join(base, "wrong-state");
      let error: string | undefined;
      try {
        await work;
      } catch (cause) {
        error = String(cause);
      }
      fence.assertCurrent();
      fsSync.writeFileSync(
        path.join(base, "completed.json"),
        JSON.stringify({
          error,
          pid: candidate?.pid,
          bytesWritten: candidatePipe?.bytesWritten,
          code: candidate?.exitCode,
          signal: candidate?.signalCode,
        }),
      );
    },
    { existingAuthority: authority },
  );
}

export function startActivationHelper(
  fixture: ActivationFixture,
  anchor: string,
  action: "status" | "repair" | "retire",
  faults?: ActivationFault[],
) {
  return startActivationProcess({
    base: fixture.base,
    args: [path.join(anchor, "recovery.mjs"), action],
    preload: fixture.preload,
    faults,
  });
}

async function runOriginalActivation(value: ActivationFixture, mode: string) {
  if (mode === "admission") {
    const { runCliWithExitFinalization } = await import("../cli/one-shot-exit.js");
    const { assertUpdatePackageActivationAdmission, withUpdateAdmissionReporting } =
      await import("../cli/update-cli/update-command-result.js");
    // Exercise the operator diagnostic, not Node's uncaught-error source excerpt.
    await runCliWithExitFinalization({
      run: () =>
        withUpdateAdmissionReporting({}, async () => {
          assertUpdatePackageActivationAdmission(value.packageRoot);
        }),
      onError(error) {
        throw error;
      },
    });
    return;
  }
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const { createManagedHandoffLeaseStore } =
    await import("./update-managed-service-handoff-lease.js");
  const { captureManagedUpdateLeaseDatabaseIdentity } =
    await import("./update-managed-service-handoff-database.js");
  const { runGlobalPackageUpdateSteps } = await import("./package-update-steps.js");
  const { resolveGlobalInstallTarget } = await import("./update-global.js");
  const { createUpdateRun, adoptUpdateRun } = await import("./update-run-ledger.js");
  const store = createManagedHandoffLeaseStore({
    databasePath: value.databasePath,
    serviceManagerEnv: process.env,
  });
  const bootstrap = store.acquire(value.packageRoot, randomUUID(), { kind: "update" });
  assert.ok(bootstrap.kind === "acquired");
  assert.ok(store.release(bootstrap.lease));
  const authority = {
    ...captureManagedUpdateLeaseDatabaseIdentity(value.databasePath),
    installKey: value.packageRoot,
  };
  const runCommand: import("./update-global.js").CommandRunner = async (argv, options) => {
    try {
      const result = await captureCommand(argv[0]!, argv.slice(1), {
        cwd: options.cwd ?? value.base,
        env: { ...process.env, npm_config_prefix: value.prefix, ...options.env },
        timeout: options.timeoutMs,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      if (typeof result.code !== "number") {
        throw error;
      }
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code };
    }
  };
  // The original CLI admits its ledger run before activation. Child binding
  // must adopt that real record before the executor grant can cross the pipe.
  const created = createUpdateRun({ trigger: "cli" }, { env: process.env });
  const { runId, origin } = adoptUpdateRun(created.runId, { env: process.env });
  assert.equal(origin.driver?.pid, process.pid);
  await withUpdateCommandExecutor(
    runId,
    async (executor) => {
      const fence = await executor.enter(value.packageRoot);
      const installTarget = await resolveGlobalInstallTarget({
        manager: "npm",
        runCommand,
        timeoutMs: CHILD_TIMEOUT_MS,
        pkgRoot: value.packageRoot,
        honorPackageRoot: true,
        packageName: "openclaw",
      });
      let transaction: import("./package-update-steps.js").PackageUpdateTransaction | undefined;
      const result = await runGlobalPackageUpdateSteps({
        installTarget,
        installSpec: value.candidateTarball,
        packageName: "openclaw",
        packageRoot: value.packageRoot,
        runCommand,
        runStep: async ({ name, argv, ...options }) => {
          const started = Date.now();
          const output = await runCommand(argv, options);
          return {
            name,
            command: argv.join(" "),
            cwd: options.cwd ?? value.base,
            durationMs: Date.now() - started,
            exitCode: output.code,
            stdoutTail: output.stdout,
            stderrTail: output.stderr,
          };
        },
        activation: {
          fence,
          nodeRunner: process.execPath,
          onPrepared: (command) => process.stdout.write(`${command}\n`),
          onUnavailable: (message) => process.stdout.write(`${message}\n`),
        },
        ...(mode === "update"
          ? {}
          : {
              onTransaction: (retained) => {
                transaction = retained;
              },
            }),
        timeoutMs: CHILD_TIMEOUT_MS,
      });
      assert.equal(result.failedStep, null, JSON.stringify(result));
      if (mode === "rollback") {
        assert.ok(transaction);
        const restored = await transaction.rollback(fence.assertCurrent);
        assert.equal(restored.exitCode, 0, JSON.stringify(restored));
      }
      if (mode.startsWith("post-core")) {
        const { continuePostCoreUpdateInFreshProcess } =
          await import("../cli/update-cli/update-command-post-core.js");
        try {
          const resumed = await continuePostCoreUpdateInFreshProcess({
            root: value.packageRoot,
            channel: "stable",
            requestedChannel: null,
            opts: {
              json: true,
              restart: false,
              yes: true,
              run: { runId, env: process.env, executorFence: fence },
            },
            pluginInstallRecords: {},
            updateStartedAtMs: Date.now(),
            timeoutMs: mode === "post-core-timeout" ? 5000 : CHILD_TIMEOUT_MS,
            nodeRunner: process.execPath,
          });
          assert.equal(resumed.resumed, true, JSON.stringify(resumed));
          fence.assertCurrent();
          emitReceiverEvent("post-core-returned");
        } catch (error) {
          // Successful access here proves the failed child's custody was settled
          // before the parent became writable again.
          fence.assertCurrent();
          process.stdout.write(`${String(error)}\n`);
          assert.ok(transaction);
          const restored = await transaction.rollback(fence.assertCurrent);
          assert.equal(restored.exitCode, 0, JSON.stringify(restored));
          emitReceiverEvent("post-core-failed-settled");
        }
      }
      process.stdout.write(
        `${EVENT_PREFIX}${JSON.stringify({
          event: "update-returned",
          pid: process.pid,
        })}\n`,
      );
      // Keep the admitted original owner alive after stage-finally. The parent
      // deliberately kills it, so no thrown mock error can stand in for process death.
      await new Promise<never>(() => {
        setInterval(() => {}, 1000);
      });
    },
    { existingAuthority: authority },
  );
}

function emitReceiverEvent(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(
    `${EVENT_PREFIX}${JSON.stringify({ event, pid: process.pid, ...fields })}\n`,
  );
}

export async function runActivationReceiver(params: {
  base: string;
  receiver: "complete" | "hold" | "descendant";
  legacy: boolean;
}) {
  const operation = async (opts: import("../cli/update-cli/shared.js").UpdateCommandOptions) => {
    opts.run?.executorFence?.assertCurrent();
    emitReceiverEvent("receiver-admitted", { fenced: Boolean(opts.run?.executorFence) });
    await fs.writeFile(path.join(params.base, "receiver-mutation"), "admitted\n");
    opts.run?.executorFence?.assertCurrent();
    emitReceiverEvent("receiver-ready", { fenced: Boolean(opts.run?.executorFence) });
    if (params.receiver === "hold") {
      await new Promise<never>(() => setInterval(() => {}, 1000));
    }
    if (params.receiver === "descendant") {
      const descendant = spawn(
        process.execPath,
        ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
        { stdio: "inherit" },
      );
      assert.ok(descendant.pid);
    }
    const result: import("../cli/update-cli/update-command-plugins.js").PostCorePluginUpdateResult =
      {
        status: "ok",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
      };
    opts.run?.executorFence?.assertCurrent();
    await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH!, JSON.stringify(result));
  };
  if (params.legacy) {
    // v2026.4.29 update-command.ts:1189-1210,1273-1337 used ENV and a result file,
    // without a private descriptor. This is that wire contract, not an old artifact.
    assert.equal(process.env.OPENCLAW_UPDATE_POST_CORE, "1");
    assert.equal(process.env.OPENCLAW_UPDATE_POST_CORE_CHANNEL, "stable");
    return operation({});
  }
  const { withPostCoreUpdateExecutor } =
    await import("../cli/update-cli/update-command-post-core-executor.js");
  return withPostCoreUpdateExecutor({}, operation);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, encoded] = process.argv.slice(2);
  assert.ok(mode && encoded, "activation child requires its fixture");
  if (mode === "driver-custody") {
    await runActivationDriverCustody(JSON.parse(encoded) as ActivationDriverCustodyFixture);
  } else {
    await runOriginalActivation(JSON.parse(encoded) as ActivationFixture, mode);
  }
}
