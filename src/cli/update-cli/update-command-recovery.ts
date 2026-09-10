import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";

export class UpdateCommandRecoveryPendingError extends Error {
  override name = "UpdateCommandRecoveryPendingError";
}

/** Refuse retained recovery before any package-only effects or diagnostic writes. */
export function assertUpdateCommandRecovery(opts: UpdateCommandOptions): void {
  opts.run?.executorFence?.assertCurrent();
  if (opts.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  if (opts.run) {
    const current = loadUpdateRecovery(opts.run.runId, { env: opts.run.env });
    if (current) {
      throw new UpdateRecoveryRequiredError(current);
    }
  }
}
