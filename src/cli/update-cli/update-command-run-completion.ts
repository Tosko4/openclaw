import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import {
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { inspectUpdateRecoveries, loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { UpdateCommandOptions } from "./shared.js";

export function completeUpdateCommandRun(
  result: UpdateRunResult,
  run: UpdateCommandOptions["run"],
  downtimeMs?: number,
): UpdateRunResult {
  if (!run) {
    return result;
  }
  // A process-local result cannot complete an operationally pending update or
  // authorize package retirement. Only the durable finalizer may close it.
  const inspected = inspectUpdateRecoveries({ env: run.env }).find(
    (entry) => entry.record.runId === run.runId,
  );
  // A matching historical record can only project its saved outcome or remain
  // pending below. The mutable fallback still uses strict execution admission;
  // unrelated legacy evidence must not become an absent/clean recovery state.
  const recovery =
    inspected?.format === "legacy-serving"
      ? inspected.record
      : loadUpdateRecovery(run.runId, { env: run.env });
  if (
    recovery?.terminal &&
    getUpdateRun(run.runId, { env: run.env })?.status === recovery.terminal.status
  ) {
    // Read the atomic durable outcome; diagnostics never authorize retention cleanup.
    return {
      ...result,
      status: recovery.terminal.status === "succeeded" ? "ok" : "error",
      reason:
        recovery.terminal.status === "succeeded"
          ? undefined
          : (recovery.primaryFailure?.code ?? "update-rolled-back"),
      runId: run.runId,
    };
  }
  if (recovery) {
    return {
      ...result,
      status: "error",
      reason: result.reason ?? "update-recovery-pending",
      runId: run.runId,
    };
  }
  const normalized = normalizeControlPlaneUpdateResult({ ...result, runId: run.runId });
  const recordOptions = { env: run.env, redactPaths: result.root ? [result.root] : [] };
  const active = getUpdateRun(run.runId, recordOptions);
  if (active) {
    recordUpdateRunPhase(
      run.runId,
      active.phase,
      { before: result.before, after: result.after },
      recordOptions,
    );
  }
  for (const step of result.steps.flatMap(updateRunStepsFromResultStep)) {
    recordUpdateRunStep(run.runId, step, recordOptions);
  }
  // Both finalization and outer CLI unwind come here. A verified restored generation
  // stays with its helper until native recovery finishes; neither caller may close it early.
  const helperRecoveryPending =
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
    result.recovery?.serviceRestartSafe === true &&
    result.recovery.packageRollbackVerified === true &&
    result.recovery.service === undefined;
  if (!helperRecoveryPending) {
    finishUpdateRun(
      run.runId,
      {
        status:
          normalized.status === "ok"
            ? "succeeded"
            : normalized.status === "error"
              ? "failed"
              : "skipped",
        reason: normalized.reason,
        after: normalized.after,
        downtimeMs,
      },
      recordOptions,
    );
  }
  return { ...result, runId: run.runId };
}
