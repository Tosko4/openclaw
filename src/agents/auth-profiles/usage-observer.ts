import { isDeepStrictEqual } from "node:util";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveUserPath } from "../../utils.js";
import { cloneAuthProfileStore } from "./clone.js";
import { captureAuthProfileOwnerScope } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import {
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
  type RuntimeAuthSharedOwner,
} from "./runtime-snapshot-owner.js";
import {
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";
import { fingerprintAuthProfileAvailabilityState } from "./usage-state.js";

type UsageObservation = { authStore: AuthProfileStore; isCurrent: () => boolean };
type UsageObserver = (store: AuthProfileStore) => UsageObservation;
type Snapshot = OwnedRuntimeAuthProfileStoreSnapshotEntry;
type SnapshotSlot = {
  databasePath: string;
  owner?: RuntimeAuthSharedOwner;
  published: boolean;
};

const observers = new WeakMap<AuthProfileStore, UsageObserver>();

/** Capture addressing before discovery yields; observer reads never resolve storage ownership. */
export function captureRuntimeAuthProfileUsageObserver(params: {
  agentDir: string;
  inheritedAuthDir?: string;
  env?: NodeJS.ProcessEnv;
}): UsageObserver {
  const env = params.env ?? process.env;
  const coldOwner = { kind: "unresolved", scope: captureAuthProfileOwnerScope(env) } as const;
  const filename = (directory: string) => {
    if (!directory.trim()) {
      throw new Error("An agent directory is required to observe auth usage.");
    }
    return resolveAuthProfileDatabasePath(resolveUserPath(directory, env));
  };
  const sharedCandidates = [
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: coldOwner.scope.stateDir }),
    resolveAuthProfileDatabasePath(coldOwner.scope.sharedMainDir),
  ];
  const snapshots = new Map<string, { revision: number; snapshot: Snapshot | undefined }>();
  const readSnapshot = (databasePath: string): Snapshot | undefined => {
    const revision = getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath);
    const previous = snapshots.get(databasePath);
    if (previous?.revision === revision) {
      return previous.snapshot;
    }
    const snapshot = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath);
    snapshots.set(databasePath, { revision, snapshot });
    return snapshot;
  };
  const captureSlot = (databasePath: string): SnapshotSlot => {
    const snapshot = readSnapshot(databasePath);
    return { databasePath, owner: snapshot?.owner, published: snapshot !== undefined };
  };
  const requested = captureSlot(filename(params.agentDir));
  let inherited = params.inheritedAuthDir
    ? captureSlot(filename(params.inheritedAuthDir))
    : undefined;
  let retired: Error | undefined;
  const readSlot = (slot: SnapshotSlot): { snapshot?: Snapshot; error?: Error } => {
    const snapshot = readSnapshot(slot.databasePath);
    if (!snapshot) {
      return slot.published
        ? {
            error: new Error(
              "Prepared auth usage snapshot disappeared; reacquire the model catalog.",
            ),
          }
        : {};
    }
    if (!slot.owner) {
      const matches =
        snapshot.owner.kind === "resolved"
          ? runtimeAuthProfileSnapshotSharesOwner(coldOwner, snapshot.owner)
          : isDeepStrictEqual(coldOwner, snapshot.owner);
      if (!matches) {
        return {
          error: new Error(
            "Prepared auth usage publication has another owner; reacquire the model catalog.",
          ),
        };
      }
    } else if (
      runtimeAuthSharedOwnerRebound(slot.owner, snapshot.owner) ||
      (slot.owner.kind === "resolved" &&
        snapshot.owner.kind === "resolved" &&
        slot.owner.location !== snapshot.owner.location)
    ) {
      retired ??= new Error("Prepared auth usage owner changed; reacquire the model catalog.");
      return { error: retired };
    }
    slot.owner = snapshot.owner;
    slot.published = true;
    return { snapshot };
  };
  const resolveInherited = (): "ambiguous" | undefined => {
    if (inherited) {
      return undefined;
    }
    const owners = new Map<string, Extract<RuntimeAuthSharedOwner, { kind: "resolved" }>>();
    for (const databasePath of [requested.databasePath, ...sharedCandidates]) {
      const owner = readSnapshot(databasePath)?.owner;
      if (owner?.kind === "resolved" && runtimeAuthProfileSnapshotSharesOwner(coldOwner, owner)) {
        owners.set(JSON.stringify([owner.sharedDatabasePath, owner.location]), owner);
      }
    }
    // Cold scopes can name both storage layouts. Only a unique producer selects the default.
    if (owners.size === 1) {
      const owner = owners.values().next().value;
      if (owner) {
        inherited = { ...captureSlot(owner.sharedDatabasePath), owner };
      }
    }
    return owners.size > 1 ? "ambiguous" : undefined;
  };
  let previousRequested: Snapshot | undefined;
  let previousInherited: Snapshot | undefined;
  let effective: AuthProfileStore | undefined;
  const read = (): { store?: AuthProfileStore; error?: Error } => {
    if (retired) {
      return { error: retired };
    }
    const inheritance = resolveInherited();
    const local = readSlot(requested);
    const parent: ReturnType<typeof readSlot> = inherited ? readSlot(inherited) : {};
    const error = local.error ?? parent.error;
    if (error) {
      return { error };
    }
    if (inheritance === "ambiguous") {
      return {};
    }
    if (local.snapshot !== previousRequested || parent.snapshot !== previousInherited) {
      previousRequested = local.snapshot;
      previousInherited = parent.snapshot;
      effective =
        inherited &&
        local.snapshot &&
        parent.snapshot &&
        requested.databasePath !== inherited.databasePath
          ? mergeAuthProfileStores(parent.snapshot.store, local.snapshot.store, {
              preserveBaseRuntimeExternalProfiles: true,
            })
          : (local.snapshot ?? parent.snapshot)?.store;
    }
    return { store: effective };
  };
  // Pin any already-published ownership before the caller starts asynchronous preparation.
  read();
  const observer: UsageObserver = (capturedStore) => {
    const captured = cloneAuthProfileStore(capturedStore);
    const profileIds = Object.keys(captured.profiles).filter(
      (id) => !isUserModelAuthProfileId(id) && !captured.runtimeExternalProfileIds?.includes(id),
    );
    const usageFrom = (store: AuthProfileStore | undefined) => {
      const usage = { ...captured.usageStats };
      for (const id of profileIds) {
        if (
          !store?.profiles[id] ||
          store.runtimeExternalProfileIds?.includes(id) ||
          !isDeepStrictEqual(captured.profiles[id], store.profiles[id])
        ) {
          continue;
        }
        const stats = store.usageStats?.[id];
        if (stats) {
          usage[id] = stats;
        } else {
          delete usage[id];
        }
      }
      return usage;
    };
    const fingerprint = (usage: AuthProfileStore["usageStats"]) =>
      JSON.stringify(profileIds.map((id) => fingerprintAuthProfileAvailabilityState(usage?.[id])));
    const initial = read();
    if (initial.error) {
      throw initial.error;
    }
    const usage = usageFrom(initial.store);
    const expected = fingerprint(usage);
    let lastStore = initial.store;
    let lastFingerprint = expected;
    let current = true;
    const authStore = { ...capturedStore, usageStats: structuredClone(usage) };
    bindRuntimeAuthProfileUsageObserver(authStore, observer);
    return {
      authStore,
      isCurrent: () => {
        if (!current) {
          return false;
        }
        const next = read();
        if (next.error) {
          current = false;
          return false;
        }
        if (next.store !== lastStore) {
          lastStore = next.store;
          lastFingerprint = fingerprint(usageFrom(next.store));
        }
        current = lastFingerprint === expected;
        return current;
      },
    };
  };
  return observer;
}

export function bindRuntimeAuthProfileUsageObserver(
  store: AuthProfileStore,
  observer: UsageObserver,
): void {
  observers.set(store, observer);
}

export function copyRuntimeAuthProfileUsageObserver(
  source: AuthProfileStore | undefined,
  target: AuthProfileStore,
): void {
  const observer = source && observers.get(source);
  if (observer) {
    observers.set(target, observer);
  } else {
    observers.delete(target);
  }
}

export function prepareRuntimeAuthProfileUsageObserver(store: AuthProfileStore): UsageObservation {
  const observer = observers.get(store);
  return observer ? observer(store) : { authStore: store, isCurrent: () => true };
}
