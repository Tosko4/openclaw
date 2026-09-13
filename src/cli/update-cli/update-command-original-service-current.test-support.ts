import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServiceState } from "../../daemon/service.js";
import * as integrity from "../../infra/package-update-integrity.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  observeOriginalManagedServiceRuntime,
  revalidateOriginalManagedServiceRuntime,
} from "./update-command-original-service.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { compensateOriginalManagedService } from "./update-command-service-recovery.js";

type Fixture = {
  state: OpenClawTestState;
  rootA: string;
  rootB: string;
  before: PreManagedServiceStop;
  serviceState: GatewayServiceState;
  mocks: {
    capability: Mock;
    nativeRestart: Mock;
    restart: Mock;
    health: Mock;
    readiness: Mock;
  };
};

// Current composition only: real observations, admission and candidate-native helper;
// receiver probe, native service and HTTP leaves are inert. No native command executes.
export function registerCurrentF3Controls(fixture: () => Fixture) {
  const admitted = async (
    operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
    retained = true,
  ) => {
    const { state, rootA, rootB } = fixture();
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    };
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(rootB, retained ? { serviceRoot: rootA } : {});
      await operation(run);
    });
  };

  it.each(["timeout", "read-error", "later-timeout", "launcher-drift", "read-window"] as const)(
    "current F3 mandatory identity and optional tree: %s",
    async (scenario) => {
      const { rootA, rootB, before } = fixture();
      const createReader = integrity.createPackageIntegrityReader;
      let treeReads = 0;
      let displaced = false;
      vi.spyOn(integrity, "createPackageIntegrityReader").mockImplementation((timeout) => {
        const reader = createReader(timeout);
        return {
          ...reader,
          tree: async (root, originalRoot) => {
            treeReads++;
            if (scenario === "read-error") {
              throw new Error("mandatory package access failed");
            }
            if (scenario !== "later-timeout" || treeReads > 1) {
              throw new integrity.PackageIntegrityTimeoutError(30_000);
            }
            return reader.tree(root, originalRoot);
          },
          launcher: async (launcher) => {
            const value = await reader.launcher(launcher);
            if (scenario === "read-window" && !displaced) {
              displaced = true;
              await fs.rename(rootA, `${rootA}-displaced`);
              await fs.cp(`${rootA}-displaced`, rootA, { recursive: true });
            }
            return value;
          },
        };
      });
      await admitted(async (run) => {
        const observation = observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run } },
          before,
        );
        if (["read-error", "later-timeout", "read-window"].includes(scenario)) {
          await expect(observation).rejects.toMatchObject({
            reason: "original-service-unverified",
          });
          return;
        }
        const original = await observation;
        expect(original).toMatchObject({ root: rootA, version: "2026.9.3", verified: true });
        expect(original).not.toHaveProperty("packageFingerprint");
        expect(original).toHaveProperty(
          "packageFingerprintWarning",
          expect.stringContaining("full package contents are unverified"),
        );
        expect(treeReads).toBe(1);
        if (!original || !run.executorFence) {
          throw new Error("missing admitted observation");
        }
        if (scenario === "launcher-drift") {
          await fs.appendFile(path.join(rootA, "dist/index.js"), "// replaced\n");
          await expect(
            revalidateOriginalManagedServiceRuntime(original, () =>
              run.executorFence!.assertCurrent(),
            ),
          ).rejects.toThrow("changed");
        } else {
          await revalidateOriginalManagedServiceRuntime(original, () =>
            run.executorFence!.assertCurrent(),
          );
          expect(treeReads).toBe(1);
        }
      });
    },
  );

  it.each([
    "unsupported",
    "capable",
    "scheduled",
    "uncertain",
    "not-ready",
    "no-restart",
    "no-retained-custody",
    "definition-drift",
    "manager-drift",
    "authority-lost",
  ] as const)("current F3 candidate-native selection: %s", async (scenario) => {
    const { state, rootA, rootB, before, serviceState, mocks } = fixture();
    const probe = createDeferred<boolean>();
    const started = createDeferred();
    mocks.capability.mockImplementation(async () => {
      started.resolve();
      return probe.promise;
    });
    const result: UpdateRunResult = {
      status: "error" as const,
      mode: "npm" as const,
      root: rootB,
      reason: "named-B-doctor-failure",
      steps: [],
      durationMs: 1,
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" as const },
    };
    await admitted(async (run) => {
      const original = await observeOriginalManagedServiceRuntime(
        { root: rootB, opts: { run } },
        before,
      );
      expect(original?.verified).toBe(true);
      const config = await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!);
      const packageB = await fs.readFile(path.join(rootB, "package.json"));
      if (scenario === "scheduled") {
        mocks.nativeRestart.mockResolvedValue({ outcome: "scheduled" });
      }
      if (scenario === "uncertain") {
        mocks.nativeRestart.mockRejectedValue(
          new UpdateCommandRecoveryPendingError("native cleanup unconfirmed"),
        );
      }
      if (scenario === "not-ready") {
        mocks.readiness.mockResolvedValue({ readyz: 503 });
      }
      const restore = vi.fn();
      const compensation = compensateOriginalManagedService(
        {
          result,
          opts: { json: true, run },
          preManagedServiceStop: {
            ...before,
            stopped: true,
            windowsTaskAutoStartRecovery: {
              suspended: Promise.resolve(true),
              handoff() {},
              interrupted: () => false,
              beginMutation() {},
              restore,
              complete: vi.fn(),
            },
          },
          originalManagedServiceRuntime: original,
          allowGatewayRestart: scenario !== "no-restart",
          timeoutMs: 30_000,
        },
        () => run.executorFence!.assertCurrent(),
      );
      // Attach before releasing the probe so an authority refusal cannot be unhandled.
      const outcome = compensation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      if (scenario !== "no-restart") {
        await Promise.race([started.promise, outcome]);
        expect(mocks.capability).toHaveBeenCalledOnce();
        expect(mocks.nativeRestart).not.toHaveBeenCalled();
        expect(mocks.restart).not.toHaveBeenCalled();
        if (scenario === "definition-drift") {
          serviceState.command!.programArguments.push("--port", "19997");
        }
        if (scenario === "manager-drift") {
          serviceState.env = {
            ...state.env,
            OPENCLAW_LAUNCHD_LABEL: "different-manager",
            OPENCLAW_SYSTEMD_UNIT: "different.service",
          };
        }
        if (scenario === "authority-lost") {
          run.executorFence = undefined;
        }
        probe.resolve(scenario === "capable");
      }
      const settled = await outcome;
      if (["scheduled", "uncertain", "authority-lost", "no-retained-custody"].includes(scenario)) {
        expect(settled.error).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      } else {
        const healthy = scenario === "unsupported" || scenario === "capable";
        expect(settled.error).toBeUndefined();
        expect(settled.value).toMatchObject({
          rolledBack: false,
          originalServiceRecovery: healthy ? "healthy" : "failed",
          result: {
            status: result.status,
            root: rootB,
            reason: result.reason,
            recovery: { serviceRestartSafe: false },
          },
        });
      }
      expect(mocks.restart).toHaveBeenCalledTimes(scenario === "capable" ? 1 : 0);
      expect(restore).toHaveBeenCalledTimes(scenario === "capable" ? 1 : 0);
      expect(mocks.nativeRestart).toHaveBeenCalledTimes(
        ["unsupported", "scheduled", "uncertain", "not-ready"].includes(scenario) ? 1 : 0,
      );
      if (scenario === "unsupported") {
        expect(mocks.capability).toHaveBeenCalledWith(
          expect.objectContaining({
            root: rootA,
            executor: run.executorFence,
            nodeRunner: process.execPath,
          }),
        );
        expect(mocks.nativeRestart).toHaveBeenCalledWith(
          expect.objectContaining({
            env: original?.service.serviceEnv,
            preserveDefinition: true,
            preserveAutoStart: true,
          }),
        );
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ expectedVersion: "2026.9.3", expectedBuildId: "build-A" }),
        );
        expect(mocks.readiness).toHaveBeenCalledTimes(2);
      }
      expect(await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!)).toEqual(config);
      expect(await fs.readFile(path.join(rootB, "package.json"))).toEqual(packageB);
    }, scenario !== "no-retained-custody");
  });
}
