import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedCandidateProof,
  readManagedCandidateState,
} from "../../scripts/e2e/lib/upgrade-survivor/update-run-package-candidate.mjs";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const candidate = { version: "2026.9.4", commit: "a".repeat(40), buildId: "candidate-build" };

function successfulProof() {
  return {
    manager: "simulated-systemd",
    candidate,
    baseline: { version: "2026.9.3" },
    rpc: {
      ok: true,
      runId: "run",
      handoff: { status: "started", pid: 20 },
      result: { before: { version: "2026.9.3" } },
    },
    launch: {
      runId: "run",
      helper: { pid: 20, startIdentity: "200" },
      parent: { pid: 10, startIdentity: "100" },
      parentLiveAtLaunch: true,
    },
    helperLeaseObserved: true,
    runnerLeaseObserved: true,
    parentExited: true,
    helperExited: true,
    leaseReleased: true,
    helperExitCode: 0,
    run: {
      runId: "run",
      trigger: "api",
      status: "succeeded",
      reason: null,
      before: { version: "2026.9.3" },
      after: { version: "2026.9.4" },
      verification: {
        runningVersion: "2026.9.4",
        runningBuildId: "candidate-build",
        serviceRunning: true,
        versionMatch: true,
      },
      steps: [{ step: "verifying", status: "completed" }],
    },
    nativeBefore: { pid: 10, startIdentity: "100" },
    nativeAfter: { pid: 30, startIdentity: "300" },
    nativeBeforeExited: true,
    installedBuild: candidate,
    ready: true,
    health: { ok: true },
  };
}

describe("managed candidate update proof", () => {
  it.skipIf(process.platform !== "linux").each([
    {
      label: "rejected RPC",
      rpc: { ok: false, result: { status: "skipped", reason: "not-git-install" } },
      diagnostic: "not-git-install; see update-rpc.json",
    },
    {
      label: "missing handoff",
      rpc: { ok: true, result: { before: { version: "2026.9.3" } } },
      diagnostic: "update.run must launch the managed helper",
    },
    {
      label: "wrong baseline",
      rpc: {
        ok: true,
        handoff: { status: "started", pid: 20 },
        result: { before: { version: "2026.4.26" } },
      },
      diagnostic: "update.run baseline identity changed",
    },
  ])("stops promptly after an exit-zero $label without a scope", ({ rpc, diagnostic }) => {
    const root = tempDirs.make("openclaw-managed-rejected-rpc-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(root, "candidate-build-info.json"), JSON.stringify(candidate));
    writeFileSync(
      path.join(root, "baseline-build-info.json"),
      JSON.stringify({ version: "2026.9.3" }),
    );
    writeFileSync(
      path.join(bin, "systemctl"),
      `#!${process.execPath}\nconsole.log("MainPID=${process.pid}");\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, "openclaw"),
      `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(rpc))});\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/e2e/lib/upgrade-survivor/update-run-package-candidate.mjs"),
        "run",
        root,
        root,
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain("[managed-candidate] FAILED (exit 1)");
    expect(JSON.parse(readFileSync(path.join(root, "update-rpc.json"), "utf8"))).toEqual(rpc);
    expect(existsSync(path.join(root, "scope.json"))).toBe(false);
    expect(existsSync(path.join(root, "summary.json"))).toBe(false);
  });

  it.each([
    { terminal: true, retained: false, accepted: true },
    { terminal: false, retained: false, accepted: false },
    { terminal: true, retained: true, accepted: false },
  ])(
    "distinguishes sampled retirement from lost custody ($terminal/$retained)",
    ({ terminal, retained, accepted }) => {
      const root = tempDirs.make("openclaw-lease-observation-");
      const stateDatabasePath = path.join(root, "state.sqlite");
      const updateLeaseDatabasePath = path.join(root, "lease.sqlite");
      writeFileSync(stateDatabasePath, "");
      writeFileSync(updateLeaseDatabasePath, "");
      let leaseReads = 0;
      let closed = 0;
      class ObservationDatabase {
        constructor(
          readonly file: string,
          options: { readOnly: boolean },
        ) {
          expect(options.readOnly).toBe(true);
        }
        prepare() {
          return {
            get: () => {
              if (this.file === stateDatabasePath) {
                return {
                  run_id: "run",
                  trigger: "api",
                  status: terminal ? "succeeded" : "running",
                  phase: "finished",
                  reason: null,
                  before_json: "{}",
                  after_json: "{}",
                  steps_json: "[]",
                  verification_json: "{}",
                };
              }
              leaseReads++;
              return leaseReads === 1 || retained
                ? {
                    owner: "owner",
                    payload_json: JSON.stringify({
                      helper: { pid: Number.MAX_SAFE_INTEGER, startIdentity: "1" },
                    }),
                  }
                : undefined;
            },
          };
        }
        close() {
          closed++;
        }
      }
      const observe = () =>
        readManagedCandidateState(ObservationDatabase, {
          stateDatabasePath,
          updateLeaseDatabasePath,
          runId: "run",
          installRoot: root,
        });
      if (accepted) {
        expect(observe()).toMatchObject({ run: { status: "succeeded" }, lease: null });
      } else {
        expect(observe).toThrow(/custody|lease|terminal/);
      }
      expect(closed).toBe(4);
    },
  );
  it("requires custody and automatic replacement, not merely an installed target version", () => {
    expect(() => assertManagedCandidateProof(successfulProof())).not.toThrow();
    const faults = [
      { rpc: { ...successfulProof().rpc, handoff: { status: "unavailable", pid: 20 } } },
      { helperLeaseObserved: false },
      { runnerLeaseObserved: false },
      { parentExited: false },
      { helperExited: false },
      { leaseReleased: false },
      { helperExitCode: 1 },
      { nativeAfter: successfulProof().nativeBefore },
      { nativeBeforeExited: false },
      { installedBuild: { ...candidate, commit: "b".repeat(40) } },
      { ready: false },
      {
        run: {
          ...successfulProof().run,
          verification: { ...successfulProof().run.verification, runningBuildId: "another-build" },
        },
      },
      { health: { ok: false } },
      {
        run: {
          ...successfulProof().run,
          status: "failed",
          reason: "managed-service-handoff-failed",
        },
      },
      { run: { ...successfulProof().run, runId: "another-run" } },
      { run: { ...successfulProof().run, steps: [{ step: "migration", status: "failed" }] } },
    ];
    for (const fault of faults) {
      expect(
        () => assertManagedCandidateProof({ ...successfulProof(), ...fault }),
        JSON.stringify(fault),
      ).toThrow();
    }
  });

  it("selects candidate coverage without changing the historical release chunk", () => {
    const options = {
      profile: "custom",
      releaseProfile: "full",
      includeOpenWebUI: false,
      liveMode: "all",
      liveRetries: 0,
      orderLanes: <T>(lanes: T[]) => lanes,
      planReleaseAll: false,
      releaseChunk: "",
      timingStore: undefined,
    } as const;
    const selected = resolveDockerE2ePlan({
      ...options,
      selectedLaneNames: ["update-run-package-candidate"],
    });
    expect(selected.plan.lanes).toEqual([
      expect.objectContaining({
        name: "update-run-package-candidate",
        imageKind: "bare",
        live: false,
        command: expect.stringContaining("test:docker:update-run-package-candidate"),
      }),
    ]);
    expect(selected.plan.needs.package).toBe(true);
    const historical = resolveDockerE2ePlan({
      ...options,
      profile: "release-path",
      releaseChunk: "package-update-self-upgrade",
      selectedLaneNames: [],
    });
    expect(historical.plan.lanes.map((lane) => lane.name)).toContain(
      "update-run-package-self-upgrade",
    );
    expect(historical.plan.lanes.map((lane) => lane.name)).not.toContain(
      "update-run-package-candidate",
    );
  });

  it.each(["default", "explicit"])(
    "retains %s receipts beside the unchanged candidate inputs",
    (artifactMode) => {
      const root = tempDirs.make("openclaw-managed-candidate-launch-");
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const dockerArgs = path.join(root, "docker-args.json");
      const tarball = path.join(root, "candidate.tgz");
      writeFileSync(tarball, "candidate fixture bytes");
      writeFileSync(
        path.join(bin, "docker"),
        `#!${process.execPath}\nif (process.argv[2] === "run") require("node:fs").writeFileSync(process.env.DOCKER_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        "bash",
        [
          path.resolve("scripts/e2e/update-run-package-self-upgrade-docker.sh"),
          "--managed-candidate",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            DOCKER_ARGS: dockerArgs,
            OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF: "1",
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            OPENCLAW_DOCKER_E2E_REPO_ROOT: root,
            OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR:
              artifactMode === "explicit" ? path.join(root, "artifacts") : "",
            OPENCLAW_CURRENT_PACKAGE_TGZ: tarball,
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.9.3",
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const args = JSON.parse(readFileSync(dockerArgs, "utf8")) as string[];
      expect(args).toContain(`${tarball}:/tmp/openclaw-current.tgz:ro`);
      expect(args).toContain("OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=openclaw@2026.9.3");
      expect(args.at(-1)).toBe("scripts/e2e/lib/upgrade-survivor/update-run-package-candidate.sh");
      const artifactRoot =
        artifactMode === "explicit"
          ? path.join(root, "artifacts")
          : path.join(root, ".artifacts/docker-tests/update-run-package-candidate");
      expect(
        args.some(
          (argument: string) =>
            argument.startsWith(`${artifactRoot}/managed-candidate.`) &&
            argument.endsWith(":/tmp/openclaw-update-run-artifacts"),
        ),
      ).toBe(true);
      expect(readFileSync(tarball, "utf8")).toBe("candidate fixture bytes");
    },
  );
});
