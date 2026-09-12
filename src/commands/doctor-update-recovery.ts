import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE } from "../infra/update-doctor-result.js";
import type { UpdateRecoveryBackupRef } from "../infra/update-recovery-backup-contract.js";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
} from "../infra/update-run-driver.js";
import { hasActiveUpdateDoctorStep, type UpdateRunRecord } from "../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../infra/update-run-recovery.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import type { beginDoctorMaintenance } from "./doctor-maintenance.js";
import type { DoctorOptions } from "./doctor-prompter.js";

type DoctorRecoveryScope = {
  runtime: RuntimeEnv;
  prepared: boolean;
  protected: boolean;
  reference?: UpdateRecoveryBackupRef;
  assertRecoveryClaim?: () => void;
  maintenance?: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
};
const doctorRecovery = new AsyncLocalStorage<DoctorRecoveryScope>();

export async function withDoctorUpdateRecovery<T>(
  runtime: RuntimeEnv,
  run: () => Promise<T>,
): Promise<T> {
  if (doctorRecovery.getStore()) {
    return run();
  }
  const scope: DoctorRecoveryScope = { runtime, prepared: false, protected: false };
  return doctorRecovery.run(scope, async () => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const failed =
      !outcome.ok &&
      !(
        outcome.error instanceof ExitError &&
        (outcome.error.code === 0 ||
          outcome.error.code === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE)
      );
    scope.protected = false;
    try {
      await scope.maintenance?.release();
    } catch (error) {
      throw new AggregateError(
        [...(failed && !outcome.ok ? [outcome.error] : []), error],
        `Doctor maintenance cleanup failed: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (failed && scope.reference) {
      runtime.error(
        `Doctor failed; the update capture remains at ${scope.reference.manifestPath}. Let the updater finish. If state recovery remains unresolved, inspect the retained capture with openclaw update status --json before manual recovery.`,
      );
    }
    if (!outcome.ok) {
      throw toErrorObject(outcome.error, "Doctor failed");
    }
    return outcome.value;
  });
}

function assertDoctorRecoveryCurrent(scope: DoctorRecoveryScope): void {
  if (!scope.maintenance) {
    throw new Error("Doctor recovery lost maintenance ownership.");
  }
  scope.maintenance.assertCurrent();
  scope.assertRecoveryClaim?.();
}

async function activeUpdateRuns() {
  const { listUpdateRunsAsync, requireCompleteActiveUpdateRuns } =
    await import("../infra/update-run-reader.js");
  return requireCompleteActiveUpdateRuns(await listUpdateRunsAsync({ active: true, limit: 100 }));
}

/** The Doctor child uses its parent's capture; shipped drivers establish one here. */
export async function prepareDoctorUpdateRecovery(options: DoctorOptions = {}): Promise<void> {
  const supplied = options.updateRecoveryBackup;
  const marked = options.updateRecoveryOwner !== undefined || supplied !== undefined;
  if (marked && (options.updateRecoveryOwner !== "driver" || !supplied?.trim())) {
    throw new Error(
      "Doctor update recovery requires both the driver owner and a backup reference.",
    );
  }
  const updating = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
  if (marked && !updating) {
    throw new Error("Doctor update recovery options require an update invocation.");
  }
  const scope = doctorRecovery.getStore();
  if (!scope || scope.prepared) {
    return;
  }
  scope.prepared = true;
  const backup = await import("../infra/update-recovery-backup.js");
  if (!updating) {
    if (options.repair === true || options.yes === true) {
      await backup.assertNoUnresolvedUpdateRecoveryBackup();
    } else {
      try {
        for (const inspection of await backup.inspectUpdateRecoveryBackups()) {
          scope.runtime.error(inspection.message);
        }
      } catch (error) {
        scope.runtime.error(
          `Warning: Retained update captures could not be inspected: ${formatErrorMessage(error)}. Run openclaw update status --json before manual recovery.`,
        );
      }
    }
    return;
  }
  if (supplied === undefined && !(await activeUpdateRuns()).some(hasActiveUpdateDoctorStep)) {
    await backup.assertNoUnresolvedUpdateRecoveryBackup();
    // Fresh-profile initialization keeps its existing, pre-admission Doctor owner.
    return;
  }
  const { guardUpdateDoctorSchemaUpgrade } = await import("./doctor-update-schema-guard.js");
  await guardUpdateDoctorSchemaUpgrade({
    runtime: scope.runtime,
    json: options.json,
    statePublicationOnly: true,
  });
  const { assertConfigWriteAllowedInCurrentMode } = await import("../config/config-write-guard.js");
  assertConfigWriteAllowedInCurrentMode();
  const [{ resolveOpenClawPackageRoot }, { beginDoctorMaintenance }] = await Promise.all([
    import("../infra/openclaw-root.js"),
    import("./doctor-maintenance.js"),
  ]);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    throw new Error("Doctor cannot identify its installation for update recovery.");
  }
  scope.maintenance = await beginDoctorMaintenance({
    options: { ...options, repair: true },
    root,
    runtime: scope.runtime,
  });
  assertDoctorRecoveryCurrent(scope);
  let reference: UpdateRecoveryBackupRef;
  if (supplied !== undefined) {
    reference = backup.readUpdateRecoveryBackupRef(supplied);
  } else {
    const inheritedRunId = process.env[UPDATE_RUN_ID_ENV]?.trim();
    // Shipped 9.2 records this step before spawning Doctor but has no driver identities.
    const matchesDoctor = (run: UpdateRunRecord) =>
      hasActiveUpdateDoctorStep(run) && (!inheritedRunId || run.runId === inheritedRunId);
    const candidates = (await activeUpdateRuns()).filter(matchesDoctor);
    const run = candidates[0];
    const parent = readUpdateRunDriver(process.ppid);
    if (!run || candidates.length !== 1 || !parent) {
      throw new Error(
        "Doctor cannot identify one admitted update run and its parent for capture. Inspect with openclaw update status --json after the updater exits.",
      );
    }
    const { listUpdateRuns } = await import("../infra/update-run-ledger.js");
    scope.assertRecoveryClaim = () => {
      const active = listUpdateRuns({ active: true, limit: 100 });
      const matching = active.filter(matchesDoctor);
      if (
        process.ppid !== parent.pid ||
        inspectUpdateRunDriver(parent) !== "alive" ||
        active.length === 100 ||
        matching.length !== 1 ||
        matching[0]?.runId !== run.runId
      ) {
        throw new Error("Doctor's admitted update run or parent changed during recovery.");
      }
    };
    const drivers = recordedUpdateRunDrivers(run);
    if (!drivers.some((driver) => sameUpdateRunDriver(driver, parent))) {
      drivers.push(parent);
    }
    reference = await backup.createUpdateRecoveryBackup({
      runId: run.runId,
      installRoot: root,
      drivers,
      assertOwned: () => assertDoctorRecoveryCurrent(scope),
    });
  }
  const manifest = await backup.verifyUpdateRecoveryBackup(reference);
  assertDoctorRecoveryCurrent(scope);
  if (manifest.installRoot !== path.resolve(root)) {
    throw new Error(`Update capture belongs to another installation: ${reference.manifestPath}`);
  }
  scope.reference = reference;
  for (const warning of manifest.warnings) {
    scope.runtime.error(`Warning: ${warning.kind}: ${warning.pluginId}: ${warning.message}`);
  }
  scope.protected = true;
}

export function getDoctorUpdateRecoveryMode(): "capture" | undefined {
  const scope = doctorRecovery.getStore();
  if (!scope?.protected) {
    return undefined;
  }
  assertDoctorRecoveryCurrent(scope);
  return "capture";
}

/** Process exit must unwind maintenance before terminating the Doctor child. */
export function doctorUpdateRecoveryRuntime(runtime: RuntimeEnv): RuntimeEnv {
  const scope = doctorRecovery.getStore();
  scope?.assertRecoveryClaim?.();
  if (!scope?.maintenance) {
    return runtime;
  }
  return {
    ...runtime,
    exit(code) {
      throw new ExitError(code);
    },
  };
}

function hasVerifiedCompletedUpdate(
  run: UpdateRunRecord | undefined,
  manifestSha256: string,
): run is UpdateRunRecord {
  if (!run) {
    return false;
  }
  const completed = (names: string[]) =>
    run.steps.some((step) => names.includes(step.step) && step.status === "completed");
  const health = run.verification;
  return (
    run.status === "succeeded" &&
    run.finishedAtMs !== null &&
    run.confirmedAtMs !== null &&
    Boolean(run.after.version) &&
    health.runningVersion === run.after.version &&
    (!run.after.buildId || health.runningBuildId === run.after.buildId) &&
    health.serviceRunning === true &&
    health.versionMatch === true &&
    health.readyz !== false &&
    health.settled !== false &&
    health.channelsReady !== false &&
    health.pluginErrors?.length === 0 &&
    completed(["openclaw doctor", "post-update verification"]) &&
    completed(["gateway verification", "verifying"]) &&
    (!run.origin.updateRecoveryCapture ||
      run.origin.updateRecoveryCapture.manifestSha256 === manifestSha256) &&
    run.origin.updateRecoveryCapture?.status !== "restore-failed" &&
    run.origin.updateRecoveryCapture?.restored !== true
  );
}

/** Admission retires proven successful captures without adopting unresolved recovery. */
export async function resolveCompletedDoctorUpdateRecovery(params: {
  installRoot: string;
  executorFence: UpdateRecoveryFence;
  runtime: RuntimeEnv;
}): Promise<void> {
  params.executorFence.assertCurrent();
  const backup = await import("../infra/update-recovery-backup.js");
  const { getUpdateRun } = await import("../infra/update-run-ledger.js");
  const { assertUpdateRecoveryAdmission } =
    await import("../infra/update-run-recovery-admission.js");
  const { assertNoPendingUpdateRecovery } = await import("../infra/update-run-recovery.js");
  for (const inspection of await backup.inspectUpdateRecoveryBackups({
    installRoot: params.installRoot,
  })) {
    params.executorFence.assertCurrent();
    if (
      inspection.terminalOutcome !== "committed" ||
      inspection.captureStatus === "restored" ||
      inspection.captureStatus === "restore-failed" ||
      !hasVerifiedCompletedUpdate(getUpdateRun(inspection.runId), inspection.ref.manifestSha256)
    ) {
      continue;
    }
    const manifest = await backup.verifyUpdateRecoveryBackup(inspection.ref);
    if (
      manifest.installRoot !== path.resolve(params.installRoot) ||
      manifest.runId !== inspection.runId
    ) {
      throw new Error(`Update capture identity changed: ${inspection.ref.manifestPath}`);
    }
    await assertUpdateRecoveryAdmission({ env: process.env });
    const assertOwned = () => {
      params.executorFence.assertCurrent();
      assertNoPendingUpdateRecovery({ env: process.env });
      if (
        [manifest.creator, ...manifest.drivers].some(
          (driver) => inspectUpdateRunDriver(driver) !== "dead",
        ) ||
        !hasVerifiedCompletedUpdate(getUpdateRun(manifest.runId), inspection.ref.manifestSha256)
      ) {
        throw new Error(
          `Update capture has no completed, exited owner: ${inspection.ref.manifestPath}. Inspect with openclaw update status --json.`,
        );
      }
    };
    assertOwned();
    await backup.writeUpdateRecoveryBackupOutcome(
      inspection.ref,
      { status: "committed" },
      { assertOwned },
    );
    await backup.retireUpdateRecoveryBackup(inspection.ref, { assertOwned });
    params.runtime.log(`Resolved update capture retired: ${inspection.ref.manifestPath}`);
  }
}
