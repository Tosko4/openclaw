// Preserve the fixture's module setup before its runtime consumers.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  invalidatePreparedModelRuntimeOwnersForAuthMutation,
  PreparedModelRuntimeAuthPublicationOwner,
} from "./prepared-model-runtime-auth-publication.js";
import {
  getPreparedModelRuntimePreferredAuthSource,
  recordPreparedModelRuntimeAuthSource,
} from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  ownerKey,
  resolvePreparedModelRuntimeOwnerBySnapshot,
} from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";
import type { ProviderModelAuthSource } from "./provider-model-auth-source-plan.js";

const environment: ProviderModelAuthSource = {
  kind: "direct",
  mode: "api-key",
  readiness: "ready",
  evidence: "environment",
  authorization: "declared",
  boundEnvVar: "OPENAI_API_KEY",
};
const profile: ProviderModelAuthSource = {
  kind: "profile",
  provider: "openai",
  profileId: "openai:new",
  mode: "api_key",
  readiness: "ready",
  cooldown: "clear",
};
const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

async function publish(config: OpenClawConfig = {}) {
  mocks.configuredAgentIds = ["pro", "other"];
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const snapshot = getPreparedModelRuntimeSnapshot({
    config,
    agentId: "pro",
    agentDir: state.agentDir("pro"),
  });
  assert(snapshot);
  return snapshot;
}

function publishAccountChange(
  snapshot: Awaited<ReturnType<typeof publish>>,
  agentDir = snapshot.agentDir,
) {
  const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
  assert(owner);
  invalidatePreparedModelRuntimeOwnersForAuthMutation(new Map([[ownerKey(owner.input), owner]]), {
    agentDir,
    affectsInheritedStores: false,
    profileSetChanged: true,
  });
}

describe("successful auth source retention through runtime publication", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "runtime-auth-source-retention" });
    await resetPreparedModelRuntimeHarness(state);
  });
  afterEach(async ({ task }) => {
    await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  });

  it("retains the serving environment source through an auth-only refresh", async () => {
    const first = await publish();
    recordPreparedModelRuntimeAuthSource(first, "openai", "model", environment);
    expect(getPreparedModelRuntimePreferredAuthSource(first, "openai", "model")).toBeUndefined();
    publishAccountChange(first);
    const next = await publish({
      agents: { defaults: { heartbeat: { agentId: "pro" }, systemAgent: { agentId: "pro" } } },
      auth: { profiles: { "openai:new": { provider: "openai", mode: "api_key" } } },
    });
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(
      environment,
    );
    expect(
      getPreparedModelRuntimePreferredAuthSource(next, "openai", "another-model"),
    ).toBeUndefined();
  });

  it("does not retain a source because another agent saved an account", async () => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot, state.agentDir("other"));
    expect(getPreparedModelRuntimePreferredAuthSource(snapshot, "openai", "model")).toBeUndefined();
  });

  it("keeps a completed refresh pending until an overlapping failed refresh releases the same owner", async () => {
    const snapshot = await publish();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    assert(owner);
    const publication = new PreparedModelRuntimeAuthPublicationOwner();
    const first = createDeferredCore();
    const second = createDeferredCore();
    const refreshed: PreparedModelRuntimeOwner[] = [];
    const refresh = (ready: readonly PreparedModelRuntimeOwner[]) => refreshed.push(...ready);
    const success = publication.withDeferredCatalogRefresh(
      { agentDir: owner.input.agentDir, affectsInheritedStores: false },
      () => [owner],
      () => first.promise,
      refresh,
    );
    const failure = publication.withDeferredCatalogRefresh(
      { agentDir: owner.input.agentDir, affectsInheritedStores: false },
      () => [owner],
      () => second.promise,
      refresh,
    );
    const rejected = expect(failure).rejects.toThrow("second refresh failed");
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(true);
    first.resolve();
    await success;
    expect(refreshed).toEqual([]);
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(true);
    second.reject(new Error("second refresh failed"));
    await rejected;
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(false);
    expect(refreshed).toEqual([owner]);
  });

  it("releases a failed refresh without starting discovery", async () => {
    const snapshot = await publish();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    assert(owner);
    const publication = new PreparedModelRuntimeAuthPublicationOwner();
    const refreshed: PreparedModelRuntimeOwner[] = [];
    await expect(
      publication.withDeferredCatalogRefresh(
        { agentDir: owner.input.agentDir, affectsInheritedStores: false },
        () => [owner],
        async () => {
          expect(publication.isCatalogRefreshDeferred(owner)).toBe(true);
          throw new Error("refresh failed");
        },
        (ready) => refreshed.push(...ready),
      ),
    ).rejects.toThrow("refresh failed");
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(false);
    expect(refreshed).toEqual([]);
  });

  it("holds discovery for a same-auth-scope successor without holding another agent", async () => {
    const snapshot = await publish();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    assert(owner);
    let currentOwners = [owner];
    const publication = new PreparedModelRuntimeAuthPublicationOwner();
    const settled = createDeferredCore();
    const refreshed: PreparedModelRuntimeOwner[] = [];
    const completion = publication.withDeferredCatalogRefresh(
      { agentDir: owner.input.agentDir, affectsInheritedStores: false },
      () => currentOwners,
      () => settled.promise,
      (ready) => refreshed.push(...ready),
    );
    mocks.configuredAgentIds = ["other"];
    await refreshPreparedModelRuntimeSnapshots(
      { agents: { entries: { other: {} } } },
      { gatewayLifecycle: true, catalogMode: "static" },
    );
    expect(
      getPreparedModelRuntimeSnapshot({
        config: snapshot.config,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
      }),
    ).toBeUndefined();
    const replacement = await publish({
      agents: { entries: { pro: { workspace: state.statePath("replacement-workspace") } } },
    });
    const replacementOwner = resolvePreparedModelRuntimeOwnerBySnapshot(replacement);
    assert(replacementOwner);
    expect(replacementOwner).not.toBe(owner);
    currentOwners = [replacementOwner];
    expect(publication.isCatalogRefreshDeferred(replacementOwner)).toBe(true);
    const otherSnapshot = getPreparedModelRuntimeSnapshot({
      config: replacement.config,
      agentId: "other",
      agentDir: state.agentDir("other"),
    });
    assert(otherSnapshot);
    const otherOwner = resolvePreparedModelRuntimeOwnerBySnapshot(otherSnapshot);
    assert(otherOwner);
    expect(publication.isCatalogRefreshDeferred(otherOwner)).toBe(false);
    settled.resolve();
    await completion;
    expect(publication.isCatalogRefreshDeferred(replacementOwner)).toBe(false);
    expect(refreshed).toEqual([replacementOwner]);
  });

  it("keeps a retired refresh completion from releasing a new lifecycle's discovery hold", async () => {
    const snapshot = await publish();
    const owner = resolvePreparedModelRuntimeOwnerBySnapshot(snapshot);
    assert(owner);
    const publication = new PreparedModelRuntimeAuthPublicationOwner();
    const retired = createDeferredCore();
    const current = createDeferredCore();
    const refreshed: PreparedModelRuntimeOwner[] = [];
    const refresh = (ready: readonly PreparedModelRuntimeOwner[]) => refreshed.push(...ready);
    const oldCompletion = publication.withDeferredCatalogRefresh(
      { agentDir: owner.input.agentDir, affectsInheritedStores: false },
      () => [owner],
      () => retired.promise,
      refresh,
    );
    publication.reset(new Error("lifecycle closed"));
    const currentCompletion = publication.withDeferredCatalogRefresh(
      { agentDir: owner.input.agentDir, affectsInheritedStores: false },
      () => [owner],
      () => current.promise,
      refresh,
    );
    retired.resolve();
    await oldCompletion;
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(true);
    expect(refreshed).toEqual([]);
    current.resolve();
    await currentCompletion;
    expect(publication.isCatalogRefreshDeferred(owner)).toBe(false);
    expect(refreshed).toEqual([owner]);
  });

  it("updates the current source only after success and delivers a deferred notice once", async () => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot);
    const next = await publish();
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile, false)).toBe(
      false,
    );
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(profile);
    expect(recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment)).toBe(
      false,
    );
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(profile);
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile)).toBe(true);
    expect(recordPreparedModelRuntimeAuthSource(next, "openai", "model", profile)).toBe(false);
  });

  it.each<OpenClawConfig>([
    { agents: { entries: { other: { model: "openai/another-model" } } } },
    { agents: { defaults: { models: { "openai/browsable": {} } } } },
    {
      models: {
        providers: {
          other: { apiKey: "explicit-key", baseUrl: "https://example.com/v1", models: [] },
        },
      },
    },
  ])("preserves the serving source through unrelated configuration edits: %j", async (config) => {
    const snapshot = await publish();
    recordPreparedModelRuntimeAuthSource(snapshot, "openai", "model", environment);
    publishAccountChange(snapshot);
    const next = await publish(config);
    expect(getPreparedModelRuntimePreferredAuthSource(next, "openai", "model")).toEqual(
      environment,
    );
  });
});
