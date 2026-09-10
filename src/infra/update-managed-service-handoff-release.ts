import type { DatabaseSync } from "node:sqlite";
import {
  deletePackageActivationTerminalRecord,
  type PackageActivationTerminalRequest,
} from "./package-update-activation-terminal.js";
import { deleteManagedHandoffLeaseRow as deleteRow } from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-schema.js";

/** Called only inside the lease owner's guarded transaction, after generation/child checks. */
export function deleteManagedHandoffLeaseRows(
  db: DatabaseSync,
  leases: readonly ManagedHandoffLease[],
  terminal?: PackageActivationTerminalRequest,
): boolean {
  if (!db.isTransaction) {
    throw new Error("Update executor release requires its guarded transaction.");
  }
  if (terminal) {
    deletePackageActivationTerminalRecord(db, leases, terminal);
  }
  for (const lease of leases) {
    if (
      !deleteRow(db, lease.key, {
        owner: lease.owner,
        payload_json: lease.payload,
        updated_at: lease.updatedAt,
      })
    ) {
      if (leases.length === 1 && !terminal) {
        return false;
      }
      throw new Error("Update executor release changed.");
    }
  }
  return true;
}
