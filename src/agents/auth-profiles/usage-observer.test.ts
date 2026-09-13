import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as machineState from "../../state/config-machine-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, type AuthProfileStoreOwner } from "./sqlite.js";
import type { AuthProfileStore, OAuthCredential, ProfileUsageStats } from "./types.js";
import {
  bindRuntimeAuthProfileUsageObserver,
  captureRuntimeAuthProfileUsageObserver,
  copyRuntimeAuthProfileUsageObserver,
  prepareRuntimeAuthProfileUsageObserver,
} from "./usage-observer.js";

const profileId = "openai:quota";
const env = {
  OPENCLAW_STATE_DIR: "/fixture/usage-observer/state",
  OPENCLAW_AGENT_DIR: "/fixture/usage-observer/shared",
};
const agentDir = "/fixture/usage-observer/agent";
const inheritedAuthDir = "/fixture/usage-observer/inherited";
const requestedPath = resolveAuthProfileDatabasePath(agentDir);
const inheritedPath = resolveAuthProfileDatabasePath(inheritedAuthDir);
const sharedPath = resolveOpenClawStateSqlitePath(env);
const legacyPath = resolveAuthProfileDatabasePath(env.OPENCLAW_AGENT_DIR);
const blocked = { blockedUntil: 50_000, blockedReason: "subscription_limit" } as const;

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: 100_000,
    accountId: "synthetic-account",
    ...overrides,
  };
}

function store(usage?: ProfileUsageStats, auth = credential()): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: auth },
    order: { openai: [profileId] },
    ...(usage ? { usageStats: { [profileId]: usage } } : {}),
  };
}

function publish(
  databasePath: string,
  value: AuthProfileStore,
  sharedDatabasePath = sharedPath,
  location: AuthProfileStoreOwner["location"] = "state-db",
) {
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    value,
    databasePath,
    path.dirname(databasePath),
    {
      databasePath,
      sharedDatabasePath,
      location,
    },
  );
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

describe("prepared auth usage observation", () => {
  it.each(["state-db", "legacy-main"] as const)(
    "adopts a later %s publication without discovering storage and carries copied bindings",
    (location) => {
      vi.spyOn(machineState, "readConfigMachineState").mockImplementation(() => {
        throw new Error("Usage observation attempted persistent ownership discovery");
      });
      const captured = store(blocked);
      const observer = captureRuntimeAuthProfileUsageObserver({ agentDir, env });
      bindRuntimeAuthProfileUsageObserver(captured, observer);
      const copied = structuredClone(captured);
      copyRuntimeAuthProfileUsageObserver(captured, copied);
      const initial = prepareRuntimeAuthProfileUsageObserver(copied);
      expect(initial.authStore.usageStats?.[profileId]).toEqual(blocked);
      expect(initial.isCurrent()).toBe(true);

      const databasePath = location === "state-db" ? sharedPath : legacyPath;
      publish(databasePath, store({ lastUsed: 7 }), databasePath, location);
      expect(initial.isCurrent()).toBe(false);
      const recovered = prepareRuntimeAuthProfileUsageObserver(copied);
      expect(recovered.authStore).toEqual({
        ...captured,
        usageStats: { [profileId]: { lastUsed: 7 } },
      });
      expect(recovered.isCurrent()).toBe(true);

      publish(databasePath, store({ ...blocked, blockedUntil: 80_000 }), databasePath, location);
      expect(recovered.isCurrent()).toBe(false);
      expect(
        prepareRuntimeAuthProfileUsageObserver(recovered.authStore).authStore.usageStats?.[
          profileId
        ]?.blockedUntil,
      ).toBe(80_000);
      expect(machineState.readConfigMachineState).not.toHaveBeenCalled();
    },
  );

  it("does not choose between conflicting default shared owners", () => {
    publish(sharedPath, store(), sharedPath);
    publish(legacyPath, store(), legacyPath, "legacy-main");
    publish(requestedPath, store(), "/fixture/other-owner/state/openclaw.sqlite");
    const captured = store(blocked);
    const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, env });
    const ambiguous = observe(captured);
    expect(ambiguous.authStore.usageStats?.[profileId]).toEqual(blocked);
    clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(legacyPath);
    expect(ambiguous.isCurrent()).toBe(false);
    expect(observe(captured).authStore.usageStats?.[profileId]).toBeUndefined();
  });

  it.each([
    { name: "inherited only", local: undefined, inherited: {}, expected: {} },
    { name: "requested block", local: blocked, inherited: {}, expected: blocked },
    { name: "requested clear", local: {}, inherited: blocked, expected: {} },
  ])("honors requested/inherited precedence: $name", ({ local, inherited, expected }) => {
    publish(inheritedPath, store(inherited));
    if (local) {
      publish(requestedPath, store(local));
    }
    const observed = captureRuntimeAuthProfileUsageObserver({ agentDir, inheritedAuthDir, env })(
      store(blocked),
    );
    expect(observed.authStore.usageStats?.[profileId]).toEqual(expected);
  });

  it("uses an existing explicit owner when the default shared publication is absent", () => {
    const sharedDatabasePath = "/fixture/other-owner/state/openclaw.sqlite";
    publish(requestedPath, store(), sharedDatabasePath);
    const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, env });
    const captured = store(blocked);
    const prepared = observe(captured);
    expect(prepared.authStore.usageStats?.[profileId]).toBeUndefined();
    expect(prepared.isCurrent()).toBe(true);
    publish(requestedPath, store(blocked), sharedDatabasePath);
    expect(prepared.isCurrent()).toBe(false);
    expect(observe(captured).authStore.usageStats?.[profileId]).toEqual(blocked);
  });

  it("rejects a foreign first publication instead of falling through to inherited health", () => {
    publish(inheritedPath, store());
    const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, inheritedAuthDir, env });
    const captured = store(blocked);
    const prepared = observe(captured);
    publish(requestedPath, store(), "/fixture/other-owner/state/openclaw.sqlite");
    expect(prepared.isCurrent()).toBe(false);
    expect(() => observe(captured)).toThrow(/another owner/);
  });

  it.each([
    { name: "rotated token", auth: credential({ access: "rotated-access" }) },
    { name: "different account", auth: credential({ accountId: "other-account" }) },
    { name: "missing profile", auth: undefined },
  ])("retains captured health for a $name", ({ auth }) => {
    publish(inheritedPath, store());
    publish(requestedPath, auth ? store({}, auth) : { version: 1, profiles: {} });
    const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, inheritedAuthDir, env });
    // A missing local row permits inheritance; use a published empty parent for that control.
    if (!auth) {
      publish(inheritedPath, { version: 1, profiles: {} });
    }
    expect(observe(store(blocked)).authStore.usageStats?.[profileId]).toEqual(blocked);
  });

  it.each(["removed", "rebound"] as const)(
    "retires a %s publication without creating a perpetually stale replacement",
    (change) => {
      publish(requestedPath, store());
      const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, env });
      const captured = store(blocked);
      const prepared = observe(captured);
      expect(prepared.authStore.usageStats?.[profileId]).toBeUndefined();
      if (change === "removed") {
        clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedPath);
      } else {
        publish(requestedPath, store(), "/fixture/other-owner/state/openclaw.sqlite");
      }
      expect(prepared.isCurrent()).toBe(false);
      expect(() => observe(captured)).toThrow(/reacquire the model catalog/);
    },
  );

  it("ignores bookkeeping changes and isolates nested mutable usage rows", () => {
    const usage = { ...blocked, failureCounts: { rate_limit: 2 } };
    publish(requestedPath, store(usage));
    const captured = store(blocked);
    const observe = captureRuntimeAuthProfileUsageObserver({ agentDir, env });
    const prepared = observe(captured);
    const stats = expectDefined(prepared.authStore.usageStats?.[profileId], "observed usage");
    expectDefined(stats.failureCounts, "observed failure counts").rate_limit = 99;
    expect(
      getRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedPath)?.usageStats?.[profileId]
        ?.failureCounts?.rate_limit,
    ).toBe(2);
    expect(observe(captured).authStore.usageStats?.[profileId]?.failureCounts?.rate_limit).toBe(2);
    publish(requestedPath, store({ ...usage, lastUsed: 9, lastProbeAt: 10, errorCount: 3 }));
    expect(prepared.isCurrent()).toBe(true);
    publish(requestedPath, store({ ...usage, blockedModel: "other", blockedScope: "model" }));
    expect(prepared.isCurrent()).toBe(false);
  });

  it("keeps unsupported identity rows and unbound stores captured-only", () => {
    const personal =
      "personal:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002";
    const captured: AuthProfileStore = {
      ...store(blocked),
      profiles: { [profileId]: credential(), external: credential(), [personal]: credential() },
      runtimeExternalProfileIds: ["external"],
      usageStats: Object.fromEntries(
        [profileId, "external", personal, "inline-api-key:openai", "synthetic"].map((id) => [
          id,
          { ...blocked },
        ]),
      ),
    };
    publish(requestedPath, { ...captured, usageStats: {} });
    const unbound = prepareRuntimeAuthProfileUsageObserver(captured);
    expect(unbound.authStore).toBe(captured);
    expect(unbound.authStore.usageStats).toEqual(captured.usageStats);
    expect(unbound.isCurrent()).toBe(true);
    const observed = captureRuntimeAuthProfileUsageObserver({ agentDir, env })(captured);
    expect(observed.authStore.usageStats).toEqual(
      Object.fromEntries(
        ["external", personal, "inline-api-key:openai", "synthetic"].map((id) => [id, blocked]),
      ),
    );
  });
});
