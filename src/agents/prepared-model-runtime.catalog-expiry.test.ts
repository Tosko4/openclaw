import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { createPreparedModelCatalogWorker } from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  setPreparedModelFullCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { createFullModelCatalogAccess } from "./prepared-model-runtime.catalog-access.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

type WorkerOwner = ReturnType<typeof createPreparedModelCatalogWorker>;
const worker = vi.hoisted(() => ({
  loadCatalog: vi.fn<WorkerOwner["loadCatalog"]>(),
  loadAuth: vi.fn<WorkerOwner["loadAuth"]>(),
}));
vi.mock("./prepared-model-catalog-worker.js", () => ({
  createPreparedModelCatalogWorker: () => worker,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const releases: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_000);
});
afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  vi.restoreAllMocks();
});

function fixture() {
  const credentials = {
    alpha: { type: "api_key" as const, key: "alpha-synthetic" },
    beta: { type: "api_key" as const, key: "beta-synthetic" },
    gamma: { type: "api_key" as const, key: "gamma-synthetic" },
  };
  const authStore = { version: 1, profiles: {} };
  const authStorage = AuthStorage.inMemory(credentials);
  const registry = createEmptyPluginRegistry();
  const native = vi.fn(async () => [
    { provider: "alpha", id: "native", name: "Native", nativeRuntime: "expiry-native" },
  ]);
  registry.agentHarnesses.push({
    pluginId: "expiry-native",
    source: "fixture",
    harness: {
      id: "expiry-native",
      label: "Expiry native",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("catalog-only fixture");
      },
      loadModelCatalog: native,
    },
  });
  const generation: PreparedModelRuntimePluginGeneration = {
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    pluginRegistry: registry,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  releases.push(retainPreparedPluginGeneration(generation));
  const agentFacts: PreparedModelRuntimeAgentFacts = {
    input: {
      agentDir: directories.make("catalog-expiry-"),
      config: {
        agents: { defaults: { model: "alpha/configured" } },
        models: {
          providers: {
            alpha: {
              baseUrl: "https://alpha.invalid",
              models: [],
              agentRuntime: { id: "expiry-native" },
            },
          },
        },
      },
    },
    env: {},
    authStore,
    credentials,
    providerIds: ["alpha", "beta", "gamma"],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
    templateAuthStorage: authStorage,
  };
  const owner: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "catalogAttempt"> = {};
  let current = true;
  const access = createFullModelCatalogAccess({
    agentFacts,
    catalogFacts: {
      modelCatalog: { entries: [], routeVariants: [] },
      templateModelRegistry: ModelRegistry.inMemory(authStorage),
      configuredRuntimeModels: [],
      inlineProviderModels: [],
    },
    pluginGeneration: generation,
    inventoryOwner: owner,
    isCurrent: () => current,
  });
  function reply(ids = ["alpha", "beta", "gamma"], expires = 1_100, revision = "first") {
    const entries = ids.map((provider) => ({ provider, id: revision, name: revision }));
    const modelCatalog: ModelCatalogSnapshot = {
      entries,
      routeVariants: entries,
      providerOutcomes: ids.map((provider) => ({ provider, status: "ready" })),
      authoritative: true,
    };
    const scopedCredentials = Object.fromEntries(
      Object.entries(credentials).filter(([id]) => ids.includes(id)),
    );
    setPreparedModelFullCatalogAuth(modelCatalog, {
      authStore,
      credentials: scopedCredentials,
      authModes: resolveUsableAgentCredentialModes(scopedCredentials),
      providerAuthLabels: new Map(),
    });
    return {
      modelCatalog,
      runtimeModels: new Map(),
      configuredRuntimeModels: [],
      providerExpiries: new Map(
        ids.map((provider) => [provider, provider === "gamma" ? 9_000 : expires]),
      ),
    };
  }
  worker.loadCatalog.mockImplementation(async (ids) => reply(ids ? [...ids] : undefined));
  return {
    access,
    owner,
    native,
    reply,
    retire: () => {
      current = false;
    },
  };
}

describe("prepared provider expiry publication", () => {
  it("returns saved inventory while refreshing expired providers without native reacquisition", async () => {
    const f = fixture();
    const initial = await f.access.loadFullModelCatalog();
    expect(f.native).toHaveBeenCalledTimes(1);
    expect(isPreparedModelCatalogFull(initial)).toBe(true);
    const gamma = f.owner.catalogInventory!.providers.get("gamma");
    const started = createDeferredCore();
    const release = createDeferredCore<Awaited<ReturnType<WorkerOwner["loadCatalog"]>>>();
    worker.loadCatalog.mockImplementationOnce(async (ids) => {
      expect(ids).toEqual(["alpha"]);
      started.resolve();
      return release.promise;
    });
    worker.loadCatalog.mockImplementationOnce(async (ids) => f.reply([...ids!], 4_000, "renewed"));
    vi.mocked(Date.now).mockReturnValue(1_200);
    expect(f.access.readFullModelCatalog()).toBe(initial);
    await started.promise;
    expect(f.native).toHaveBeenCalledTimes(1);
    try {
      release.resolve(f.reply(["alpha"], 4_000, "renewed"));
      await expect
        .poll(() => f.owner.catalogInventory?.providers.get("beta")?.expiresAt)
        .toBe(4_000);
      expect(f.owner.catalogInventory!.providers.get("gamma")).toBe(gamma);
      const published = f.access.readFullModelCatalog()!;
      expect(published.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "alpha", id: "native" }),
          expect.objectContaining({ provider: "alpha", id: "renewed" }),
          expect.objectContaining({ provider: "beta", id: "renewed" }),
          expect.objectContaining({ provider: "gamma", id: "first" }),
        ]),
      );
      expect(getPreparedModelFullCatalogAuth(published)?.credentials).toEqual({
        alpha: { type: "api_key", key: "alpha-synthetic" },
        beta: { type: "api_key", key: "beta-synthetic" },
        gamma: { type: "api_key", key: "gamma-synthetic" },
      });
      expect(published.authoritative).toBe(true);
      expect(isPreparedModelCatalogFull(published)).toBe(true);
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(worker.loadAuth).not.toHaveBeenCalled();
      expect(worker.loadCatalog.mock.calls).toEqual([[undefined], [["alpha"]], [["beta"]]]);
    } finally {
      release.resolve(f.reply(["alpha"], 4_000));
    }
  });

  it("keeps provider-only intent when queued expiry waits for a different pending scope", async () => {
    const f = fixture();
    await f.access.loadFullModelCatalog();
    const betaRelease = createDeferredCore<Awaited<ReturnType<WorkerOwner["loadCatalog"]>>>();
    const alphaStarted = createDeferredCore();
    const alphaRelease = createDeferredCore<Awaited<ReturnType<WorkerOwner["loadCatalog"]>>>();
    worker.loadCatalog
      .mockImplementationOnce(async (ids) => {
        expect(ids).toEqual(["beta"]);
        return betaRelease.promise;
      })
      .mockImplementationOnce(async (ids) => {
        expect(ids).toEqual(["alpha"]);
        alphaStarted.resolve();
        return alphaRelease.promise;
      })
      .mockImplementation(async (ids) => f.reply([...ids!], 4_000));
    vi.mocked(Date.now).mockReturnValue(1_200);
    f.access.readFullModelCatalog();
    const pending = f.access.loadFullModelCatalog({ providerIds: ["beta"], refresh: true });
    try {
      betaRelease.resolve(f.reply(["beta"], 4_000));
      await pending;
      await alphaStarted.promise;
      alphaRelease.resolve(f.reply(["alpha"], 4_000));
      await expect
        .poll(() => f.owner.catalogInventory?.providers.get("alpha")?.expiresAt)
        .toBe(4_000);
      expect(f.native).toHaveBeenCalledTimes(1);
      expect(worker.loadAuth).not.toHaveBeenCalled();
      expect(isPreparedModelCatalogFull(f.access.readFullModelCatalog()!)).toBe(true);
    } finally {
      betaRelease.resolve(f.reply(["beta"], 4_000));
      alphaRelease.resolve(f.reply(["alpha"], 4_000));
      await pending.catch(() => undefined);
    }
  });

  it("clears only the failed expiry scope and retains unattempted and fresh sibling records", async () => {
    const f = fixture();
    const initial = await f.access.loadFullModelCatalog();
    const original = new Map(f.owner.catalogInventory!.providers);
    const failed = createDeferredCore();
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      if (event.phase === "catalog-failed") {
        failed.resolve();
      }
    });
    worker.loadCatalog.mockRejectedValueOnce(new Error("alpha expiry failed"));
    vi.mocked(Date.now).mockReturnValue(1_200);
    try {
      expect(f.access.readFullModelCatalog()).toBe(initial);
      await failed.promise;
      expect(f.owner.catalogInventory!.providers.get("alpha")).toEqual({
        source: original.get("alpha")!.source,
        credentials: original.get("alpha")!.credentials,
      });
      expect(f.owner.catalogInventory!.providers.get("beta")).toBe(original.get("beta"));
      expect(f.owner.catalogInventory!.providers.get("gamma")).toBe(original.get("gamma"));
      expect(initial.refreshFailed).toBe(true);
      expect(worker.loadCatalog.mock.calls).toEqual([[undefined], [["alpha"]]]);
      expect(f.native).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("does not publish expired provider results or clear sibling state after retirement", async () => {
    const f = fixture();
    await f.access.loadFullModelCatalog();
    const original = f.owner.catalogInventory;
    const started = createDeferredCore();
    const release = createDeferredCore<Awaited<ReturnType<WorkerOwner["loadCatalog"]>>>();
    worker.loadCatalog.mockImplementationOnce(async () => {
      started.resolve();
      return release.promise;
    });
    const pending = f.access.loadFullModelCatalog({ providerIds: ["alpha"], refresh: true });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
    await started.promise;
    f.retire();
    release.resolve(f.reply(["alpha"], 4_000));
    await rejected;
    expect(f.owner.catalogInventory).toBe(original);
    expect(f.native).toHaveBeenCalledTimes(1);
    expect(worker.loadAuth).not.toHaveBeenCalled();
  });
});
