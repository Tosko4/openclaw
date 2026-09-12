import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { z } from "zod";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateStepResult } from "./update-runner-types.js";

/** A bounded diagnostic excerpt for a failed update step, never its command log or cwd. */
export function summarizeUpdateStepFailure(
  step: Pick<UpdateStepResult, "exitCode" | "termination" | "stdoutTail" | "stderrTail">,
): string {
  return truncateUtf16Safe(
    [
      step.termination ?? `Exit code: ${step.exitCode ?? "unknown"}`,
      ...[step.stdoutTail, step.stderrTail].map((tail) =>
        sliceUtf16Safe(tail?.trim().split(/\r?\n/u).at(-1) ?? "", -120),
      ),
    ]
      .filter(Boolean)
      .join("; "),
    300,
  );
}

export type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;
export type UpdateRunPhase = UpdateRunRecord["phase"];
export type UpdateRunStep = UpdateRunRecord["steps"][number];

export function hasActiveUpdateDoctorStep(
  run: UpdateRunRecord | undefined,
): run is UpdateRunRecord {
  return (
    run?.status === "running" &&
    run.steps.some((step) => step.step === "openclaw doctor" && step.status === "in_progress")
  );
}

export function resolveUpdateRecoveryTerminalOutcome(
  run: UpdateRunRecord | undefined,
  manifestSha256: string,
): "committed" | "restored" | undefined {
  if (
    !run ||
    (run.origin.updateRecoveryCapture &&
      run.origin.updateRecoveryCapture.manifestSha256 !== manifestSha256)
  ) {
    return undefined;
  }
  if (run.status === "succeeded") {
    return "committed";
  }
  if (run.status === "rolled-back" || run.origin.updateRecoveryCapture?.restored === true) {
    return "restored";
  }
  return undefined;
}

export type FinishUpdateRunResult = {
  status: Exclude<UpdateRunRecord["status"], "running">;
  reason?: string;
  after?: UpdateRunRecord["after"];
  downtimeMs?: number;
};

export function finishUpdateRunRecord(
  record: UpdateRunRecord,
  result: FinishUpdateRunResult,
): void {
  // CLI and the new Gateway may finish together. The first durable terminal outcome wins.
  if (record.status !== "running") {
    return;
  }
  const now = Date.now();
  // A thrown command or interrupted updater can miss its completion callback.
  // Terminal runs cannot retain live steps after their lifecycle closes.
  for (const step of record.steps) {
    if (step.step === record.phase || step.status === "in_progress") {
      step.status =
        result.status === "failed"
          ? "failed"
          : result.status === "skipped"
            ? "skipped"
            : "completed";
      step.endedAtMs = now;
    }
  }
  record.status = result.status;
  record.phase = "finished";
  record.reason = result.reason ?? null;
  record.finishedAtMs = now;
  record.after = { ...record.after, ...result.after };
  record.downtimeMs = result.downtimeMs ?? record.downtimeMs;
}

export type UpdateFetchFailure = {
  reason: "fetch-failed";
  failedAtMs: number;
  detail: string;
  runId: string;
};
