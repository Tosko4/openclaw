import type { PackageActivationRecord } from "../../infra/package-update-activation-record.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import type { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import type { ManagedHandoffLease } from "../../infra/update-managed-service-handoff-schema.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";

/** Private correlation sent only to the spawned candidate's inherited pipe. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  databasePath: string;
  parent: ManagedHandoffLease;
  /** Exact immediate spawner; parent always remains the original realpath lease. */
  spawner?: ManagedHandoffLease;
  /** Same-store prospective slot coverage, retained alongside the original domain. */
  slot?: { parent: ManagedHandoffLease; spawner: ManagedHandoffLease; childKey: string };
  childKey: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};
export type UpdateCommandChildBinding = (
  pid: number,
  onBound?: (identity: Readonly<ManagedHandoffLease["executor"]>) => undefined,
) => void;

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(root: string, options?: { preflight?: true }): Promise<UpdateRecoveryFence>;
  requestPackageSettlement(fence: UpdateRecoveryFence, record: PackageActivationRecord): void;
};

export type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;

export type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: UpdateCommandChildBinding,
) => Promise<T>;

export type UpdateCommandChildOwnerOptions = {
  runId: string;
  binding: () => {
    store: ReturnType<typeof createManagedHandoffLeaseStore>;
    parent: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    databasePath: string;
    databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
    slot?: { parent: ManagedHandoffLease; spawner: ManagedHandoffLease };
  };
  assertBase: () => void;
  onStart?: () => void;
};
