import { formatErrorMessage } from "../../infra/errors.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

/** Package-only finalization cannot adopt a retained full-state claim. */
export async function assertUpdateCommandPackageFinalization(
  params: Pick<FinishUpdateParams, "opts" | "result" | "ownedManagedUpdateEnv">,
): Promise<void> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    if (params.opts.run !== run || run?.executorFence !== executor) {
      throw new UpdateCommandRecoveryPendingError(
        "Package finalization lost its original executor.",
      );
    }
    executor?.assertCurrent();
  };
  try {
    assertCurrent();
    if (params.opts.recovery) {
      throw new Error(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
    await assertUpdateRecoveryAdmission({
      env: params.ownedManagedUpdateEnv ?? params.opts.run?.env,
    });
    assertCurrent();
    if (run) {
      await assertUpdateRecoveryAdmission({ env: run.env });
      assertCurrent();
    }
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
      cause,
    });
  }
}

/** Hold the originally admitted executor through package finalization awaits. */
export function createUpdateCommandFinalizationFence(
  params: Pick<FinishUpdateParams, "opts" | "result">,
): () => void {
  const originalRun = params.opts.run;
  const executor = originalRun?.executorFence;
  const assertCurrent = () => {
    try {
      if (params.opts.run !== originalRun || originalRun?.executorFence !== executor) {
        throw new Error("Package finalization lost its original executor.");
      }
      executor?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
        cause,
      });
    }
  };
  return assertCurrent;
}
