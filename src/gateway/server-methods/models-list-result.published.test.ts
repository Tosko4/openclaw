import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeAuthProfileStoreSnapshot } from "../../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  bindRuntimeAuthProfileUsageObserver,
  captureRuntimeAuthProfileUsageObserver,
} from "../../agents/auth-profiles/usage-observer.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

async function withPublishedCatalog(
  run: (context: ReturnType<typeof createModelsListTestContext>) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "published-catalog-read-" },
    async (state) => {
      await run(
        createModelsListTestContext({
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          catalog: [providerCatalogEntry("ollama", "published-model")],
          cfg: {
            agents: {
              defaults: {
                model: { primary: "ollama/published-model" },
                modelPolicy: { allow: ["ollama/*"] },
              },
            },
          },
        }),
      );
    },
  );
}

describe("models.list published inventory", () => {
  it("refuses a retired generation and permits a later current read without discovery", async () => {
    await withPublishedCatalog(async (context) => {
      const first = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      let published = { ...first, isCurrent: () => false };
      const loadDeferred = vi.fn(async () => published);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => published,
      });
      await expect(
        buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: { view: "all" },
        }),
      ).rejects.toThrow("Model catalog changed");
      published = { ...first, isCurrent: () => true };
      const current = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "all" },
      });
      expect(current.models.some((model) => model.id === "published-model")).toBe(true);
      expect(loadDeferred).not.toHaveBeenCalled();
    });
  });

  it.each(["default", "configured", "provider-config", "all"] as const)(
    "reads recovered auth in the %s view without discovery",
    async (view) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "published-catalog-recovery-",
          env: { ANTHROPIC_API_KEY: undefined },
        },
        async (state) => {
          const profileId = "anthropic:catalog";
          const blocked: AuthProfileStore = {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "anthropic",
                key: "synthetic-catalog-key",
              },
            },
            usageStats: { [profileId]: { blockedUntil: Date.now() + 86_400_000 } },
          };
          await state.writeAuthProfiles(blocked);
          setRuntimeAuthProfileStoreSnapshot(blocked, state.agentDir());
          const observe = captureRuntimeAuthProfileUsageObserver({
            agentDir: state.agentDir(),
            env: state.env,
          });
          const model: ModelDefinitionConfig = {
            id: "published-model",
            name: "Published model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1024,
          };
          const context = createModelsListTestContext({
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            catalogComplete: true,
            preparedAuthModes: { anthropic: "api_key" },
            catalog: [
              {
                id: model.id,
                name: model.name,
                provider: "anthropic",
                api: "anthropic-messages",
              },
            ],
            cfg: {
              models: {
                providers: {
                  anthropic: {
                    baseUrl: "https://api.anthropic.com",
                    api: "anthropic-messages",
                    models: [model],
                  },
                },
              },
              agents: {
                defaults: {
                  model: { primary: "anthropic/published-model" },
                  modelPolicy: { allow: ["anthropic/*"] },
                  models: { "anthropic/published-model": { agentRuntime: { id: "openclaw" } } },
                },
              },
            },
          });
          const published = expectDefined(
            await readPreparedCatalog(context, "main"),
            "Published catalog fixture must supply its owner",
          );
          bindRuntimeAuthProfileUsageObserver(published.authStore, observe);
          setRuntimeAuthProfileStoreSnapshot(
            { ...blocked, usageStats: { [profileId]: { errorCount: 0 } } },
            state.agentDir(),
          );
          const loadDeferred = vi.fn(async () => {
            throw new Error("Ordinary inventory attempted discovery");
          });
          registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
            loadDeferred,
            readPrepared: async () => published,
          });
          const result = await buildModelsListResult({
            source: { kind: "gateway", context },
            agentId: "main",
            params: { view },
          });
          expect(result.models).toEqual([
            expect.objectContaining({ id: "published-model", available: true }),
          ]);
          expect(result.models[0]).not.toHaveProperty("unavailableReason");
          expect(result.models[0]).not.toHaveProperty("unavailableUntil");
          expect(loadDeferred).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("reports a missing published owner without starting acquisition", async () => {
    await withPublishedCatalog(async (context) => {
      const published = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      const loadDeferred = vi.fn(async () => published);
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => undefined,
      });
      await expect(
        buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "main",
          params: {},
        }),
      ).rejects.toThrow("Model catalog is not ready");
      expect(loadDeferred).not.toHaveBeenCalled();
    });
  });

  it("returns the generation published by an explicit refresh", async () => {
    await withPublishedCatalog(async (context) => {
      let published = expectDefined(
        await readPreparedCatalog(context, "main"),
        "Published catalog fixture must supply its owner",
      );
      const refreshed = providerCatalogEntry("ollama", "refreshed-model");
      const loadDeferred = vi.fn(async () => {
        published = { ...published, entries: [refreshed], routeVariants: [refreshed] };
        return published;
      });
      registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
        loadDeferred,
        readPrepared: async () => published,
      });
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "all", refresh: true },
      });
      expect(result.models.some((model) => model.id === "refreshed-model")).toBe(true);
      expect(loadDeferred).toHaveBeenCalledExactlyOnceWith({
        agentId: "main",
        readOnly: false,
        refreshFullCatalog: true,
      });
    });
  });
});
