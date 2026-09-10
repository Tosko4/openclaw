// Observational proof only: never modifies product ledgers, leases, or service state.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    if (fields[0] === "Z") {
      return null;
    }
    assert.match(fields[19], /^\d+$/u);
    return { pid, startIdentity: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") {
      return null;
    }
    throw error;
  }
}

function sameProcess(identity) {
  return processIdentity(identity.pid)?.startIdentity === identity.startIdentity;
}

function readOptional(file) {
  return fs.existsSync(file) ? json(file) : null;
}

function readRow(DatabaseSync, file, query, key) {
  if (!fs.existsSync(file)) {
    return null;
  }
  // Linux container observation only. Match the lease owner's bounded busy
  // policy; close each read before the updater can rotate or migrate its DB.
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare(query).get(key) ?? null;
  } finally {
    db.close();
  }
}

function readRun(DatabaseSync, launch) {
  const row = readRow(
    DatabaseSync,
    launch.stateDatabasePath,
    "SELECT run_id, trigger, status, phase, reason, before_json, after_json, steps_json, verification_json FROM update_runs WHERE run_id = ?",
    launch.runId,
  );
  return (
    row && {
      runId: row.run_id,
      trigger: row.trigger,
      status: row.status,
      phase: row.phase,
      reason: row.reason,
      before: JSON.parse(row.before_json),
      after: JSON.parse(row.after_json),
      steps: JSON.parse(row.steps_json),
      verification: JSON.parse(row.verification_json),
    }
  );
}

function readLease(DatabaseSync, launch) {
  const row = readRow(
    DatabaseSync,
    launch.updateLeaseDatabasePath,
    "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
    launch.installRoot,
  );
  return row && { owner: row.owner, ...JSON.parse(row.payload_json) };
}

export function readManagedCandidateState(DatabaseSync, launch) {
  let run = readRun(DatabaseSync, launch);
  let lease = readLease(DatabaseSync, launch);
  if (lease && !sameProcess(lease.helper)) {
    // Release and exit can retire a sampled row before its process check.
    // Only exact terminal state plus current absence proves that retirement.
    const current = readLease(DatabaseSync, launch);
    run = readRun(DatabaseSync, launch);
    assert.equal(current, null, "lease still references a dead or replaced helper");
    assert.ok(run && run.status !== "running", "helper exited without terminal settlement");
    lease = null;
  }
  return { run, lease };
}

export function assertManagedCandidateProof(proof) {
  assert.equal(proof.manager, "simulated-systemd");
  assert.equal(proof.rpc.ok, true, "update.run must admit the update");
  assert.equal(proof.rpc.handoff?.status, "started", "update.run must launch the managed helper");
  assert.equal(proof.rpc.result?.before?.version, proof.baseline.version);
  assert.equal(proof.rpc.runId, proof.launch.runId);
  assert.equal(proof.rpc.handoff.pid, proof.launch.helper.pid);
  assert.deepEqual(proof.launch.parent, proof.nativeBefore, "handoff came from another process");
  assert.equal(proof.launch.parentLiveAtLaunch, true);
  assert.equal(proof.helperLeaseObserved, true, "real helper lease was not observed");
  assert.equal(proof.runnerLeaseObserved, true, "real updater custody was not observed");
  assert.equal(proof.parentExited, true, "old serving process remained alive");
  assert.equal(proof.helperExited, true, "helper did not settle");
  assert.equal(proof.leaseReleased, true, "helper custody was retained");
  assert.equal(proof.helperExitCode, 0, "helper did not report terminal success");
  assert.equal(proof.run.runId, proof.rpc.runId);
  assert.equal(proof.run.trigger, "api");
  assert.equal(proof.run.status, "succeeded", `update terminal outcome: ${proof.run.reason}`);
  assert.equal(proof.run.before.version, proof.baseline.version);
  assert.equal(proof.run.after.version, proof.candidate.version);
  assert.equal(proof.run.verification.runningVersion, proof.candidate.version);
  assert.equal(proof.run.verification.runningBuildId, proof.candidate.buildId);
  assert.equal(proof.run.verification.serviceRunning, true);
  assert.equal(proof.run.verification.versionMatch, true);
  assert.equal(
    proof.run.steps.some((step) => step.status === "failed" || step.status === "in_progress"),
    false,
  );
  assert.notDeepEqual(proof.nativeBefore, proof.nativeAfter, "manager did not replace the process");
  assert.equal(proof.nativeBeforeExited, true);
  assert.ok(proof.nativeAfter?.pid > 0);
  assert.match(proof.nativeAfter.startIdentity, /^\d+$/u);
  assert.deepEqual(
    proof.installedBuild,
    proof.candidate,
    "installed bytes have another build identity",
  );
  assert.equal(proof.ready, true, "replacement readiness failed");
  assert.equal(proof.health.ok, true, "replacement authenticated health failed");
}

async function observeUpdate(artifactDir, installedRoot) {
  const { DatabaseSync } = await import("node:sqlite");
  const candidate = json(path.join(artifactDir, "candidate-build-info.json"));
  const baseline = json(path.join(artifactDir, "baseline-build-info.json"));
  const nativeIdentity = () => {
    const runtime = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        "openclaw-gateway.service",
        "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID,FragmentPath",
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(runtime.status, 0, "native manager observation failed");
    const pid = /^MainPID=(\d+)$/mu.exec(runtime.stdout)?.[1];
    return pid && pid !== "0" ? processIdentity(Number(pid)) : null;
  };
  const nativeBefore = nativeIdentity();
  assert.ok(nativeBefore, "baseline managed process is absent");
  const rpcFile = path.join(artifactDir, "update-rpc.json");
  const rpcError = path.join(artifactDir, "update-rpc.err");
  const args = [
    "gateway",
    "call",
    "update.run",
    "--url",
    "ws://127.0.0.1:18791",
    "--token",
    "test-token",
    "--timeout",
    "120000",
    "--json",
    "--params",
    JSON.stringify({ timeoutMs: 1200000 }),
  ];
  const output = fs.openSync(rpcFile, "w");
  const errorOutput = fs.openSync(rpcError, "w");
  const child = spawn("openclaw", args, { stdio: ["ignore", output, errorOutput] });
  fs.closeSync(output);
  fs.closeSync(errorOutput);
  let rpcExit;
  const rpcDone = new Promise((resolve) => {
    child.once("error", () => {
      rpcExit = 1;
      resolve();
    });
    child.once("close", (code) => {
      rpcExit = code ?? 1;
      resolve();
    });
  });
  let launch;
  let run;
  let helperLeaseObserved = false;
  let runnerLeaseObserved = false;
  const history = [];
  let previous = "";
  let completed = false;
  try {
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      launch ??= readOptional(path.join(artifactDir, "scope.json"));
      if (rpcExit !== undefined) {
        assert.equal(rpcExit, 0, "update.run CLI failed; see update-rpc.err");
      }
      if (launch) {
        const observation = readManagedCandidateState(DatabaseSync, launch);
        run = observation.run;
        const lease = observation.lease;
        if (lease) {
          assert.equal(lease.owner, launch.handoffId, "another owner replaced the helper lease");
          assert.deepEqual(lease.helper, launch.helper, "helper lease identity changed");
          assert.equal(lease.action.kind, "update");
          helperLeaseObserved = true;
          if (lease.executor.pid !== lease.helper.pid && sameProcess(lease.executor)) {
            runnerLeaseObserved = true;
          }
        } else if (helperLeaseObserved && run?.status === "running") {
          // The terminal commit precedes lease release; reread across that race.
          run = readRun(DatabaseSync, launch);
          assert.notEqual(run?.status, "running", "helper lost custody before its terminal result");
        }
        const state = {
          run,
          lease: lease && { owner: lease.owner, helper: lease.helper, executor: lease.executor },
        };
        const serialized = JSON.stringify(state);
        if (serialized !== previous) {
          assert.ok(history.length < 256, "managed update observation exceeded its bound");
          history.push({ at: new Date().toISOString(), ...state });
          write(path.join(artifactDir, "observations.json"), history);
          previous = serialized;
        }
        if (run && run.status !== "running" && !sameProcess(launch.helper)) {
          break;
        }
      }
      await delay(250);
    }
    assert.ok(launch, "update.run did not launch a managed scope");
    assert.ok(run, "managed update did not record its run");
    assert.equal(rpcExit, 0, "update.run RPC did not finish");
    await rpcDone;
    const helperLog = fs.readFileSync(launch.logPath, "utf8");
    const helperCompletion = [
      ...helperLog.matchAll(/managed update helper completed code=(\d+)/gu),
    ].at(-1);
    const nativeAfter = nativeIdentity();
    let ready = false;
    let health = null;
    if (run.status === "succeeded" && nativeAfter) {
      const response = await fetch("http://127.0.0.1:18791/readyz", {
        signal: AbortSignal.timeout(5_000),
      });
      ready = response.ok && (await response.json()).ready === true;
      const result = spawnSync(
        "openclaw",
        [
          "gateway",
          "call",
          "health",
          "--url",
          "ws://127.0.0.1:18791",
          "--token",
          "test-token",
          "--json",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      fs.writeFileSync(path.join(artifactDir, "health.err"), result.stderr ?? "");
      if (result.status === 0) {
        health = JSON.parse(result.stdout);
      }
    }
    const proof = {
      manager: "simulated-systemd",
      candidate,
      baseline,
      rpc: json(rpcFile),
      launch,
      helperLeaseObserved,
      runnerLeaseObserved,
      run,
      nativeBefore,
      nativeAfter,
      parentExited: !sameProcess(launch.parent),
      helperExited: !sameProcess(launch.helper),
      nativeBeforeExited: !sameProcess(nativeBefore),
      leaseReleased: !readLease(DatabaseSync, launch),
      helperExitCode: helperCompletion ? Number(helperCompletion[1]) : null,
      installedBuild: json(path.join(installedRoot, "dist/build-info.json")),
      ready,
      health,
    };
    write(path.join(artifactDir, "summary.json"), proof);
    assertManagedCandidateProof(proof);
    completed = true;
    console.log(
      `Managed candidate update passed: ${baseline.version} -> ${candidate.version} (${candidate.commit}); simulated systemd, real helper custody.`,
    );
  } finally {
    if (rpcExit === undefined) {
      child.kill("SIGTERM");
    }
    await rpcDone;
    if (launch && fs.existsSync(launch.logPath)) {
      // Product output is bounded here; raw helper parameters/environment are never copied.
      const log = fs.readFileSync(launch.logPath, "utf8");
      fs.writeFileSync(path.join(artifactDir, "helper.log"), log.slice(-256 * 1024));
      if (!completed) {
        console.error(log.slice(-32 * 1024));
      }
    }
    if (!completed) {
      console.error(`[managed candidate] terminal observation: ${JSON.stringify(run ?? null)}`);
    }
  }
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "inputs") {
    const [baseline, tarball, artifactDir] = args;
    const build = json(path.join(artifactDir, "candidate-build-info.json"));
    const manifest = json(path.join(artifactDir, "candidate-package.json"));
    assert.equal(manifest.name, "openclaw");
    assert.equal(manifest.version, build.version);
    assert.match(build.commit, /^[a-f0-9]{40}$/u);
    assert.ok(build.buildId);
    assert.notEqual(baseline, `openclaw@${build.version}`, "candidate must be a different version");
    if (process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA) {
      assert.equal(build.commit, process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA);
    }
    write(path.join(artifactDir, "inputs.json"), {
      baseline,
      candidate: build,
      sha256: createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
    });
  } else if (operation === "baseline") {
    const [baseline, artifactDir] = args;
    const manifest = json(path.join(artifactDir, "baseline-package.json"));
    assert.equal(`openclaw@${manifest.version}`, baseline);
    assert.equal(
      json(path.join(artifactDir, "baseline-build-info.json")).version,
      manifest.version,
    );
  } else if (operation === "scope") {
    const [pid, paramsFile, output] = args;
    const params = json(paramsFile);
    assert.equal(params.action, "update", "only update scopes belong to this fixture");
    const helper = processIdentity(Number(pid));
    const parent = { pid: params.parentPid, startIdentity: params.parentStartIdentity };
    assert.ok(helper);
    assert.ok(sameProcess(parent), "serving parent changed before scope launch");
    assert.equal(fs.existsSync(output), false, "a second helper cannot overwrite the evidence");
    write(output, {
      runId: params.runId,
      handoffId: params.handoffId,
      helper,
      parent,
      parentLiveAtLaunch: true,
      installRoot: params.updateLeaseKey,
      stateDatabasePath: params.stateDatabasePath,
      updateLeaseDatabasePath: params.updateLeaseDatabasePath,
      logPath: params.logPath,
    });
  } else if (operation === "config") {
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 18791,
        auth: { mode: "token", token: "test-token" },
        reload: { mode: "off" },
      },
      update: { auto: { enabled: false } },
    };
    applyMockOpenAiModelConfig(config, { mockPort: 44212 });
    config.models.providers.openai.apiKey = "mock-key";
    write(args[0], config);
  } else if (operation === "run") {
    await observeUpdate(...args);
  } else {
    throw new Error("Unknown managed candidate proof operation");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    console.error("[managed-candidate] FAILED (exit 1)");
  });
}
