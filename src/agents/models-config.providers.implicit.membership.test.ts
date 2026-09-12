import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { MODELS_CONFIG_IMPLICIT_ENV_VARS } from "./models-config.e2e-harness.js";

const mocks = vi.hoisted(() => ({
  prepareProviderStaticCatalog: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderCatalog: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));
vi.mock("../plugins/provider-discovery.js", () => ({
  resolveRuntimePluginDiscoveryProviders: mocks.resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog: mocks.runProviderCatalog,
  runProviderStaticCatalog: mocks.runProviderStaticCatalog,
  groupPluginDiscoveryProvidersByOrder: (providers: ProviderPlugin[]) => ({
    simple: providers,
    profile: [],
    paired: [],
    late: [],
  }),
  normalizePluginDiscoveryResult: ({
    provider,
    result,
  }: {
    provider: ProviderPlugin;
    result?: { provider?: unknown; providers?: Record<string, unknown> } | null;
  }) =>
    result?.providers ??
    (result?.provider
      ? Object.fromEntries(
          [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].map((id) => [
            id.trim().toLowerCase(),
            result.provider,
          ]),
        )
      : {}),
  prepareProviderStaticCatalog: mocks.prepareProviderStaticCatalog,
}));

import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

function createProvider(id: string): ProviderPlugin {
  // Minimal discovery plugin used to assert orchestration, not provider behavior.
  return {
    id,
    label: id,
    auth: [],
    catalog: {
      order: "simple",
      run: async () => null,
    },
  };
}

function createTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

describe("resolveImplicitProviders configured membership", () => {
  let state: OpenClawTestState;
  let ambientHome: MockInstance<typeof os.homedir>;

  beforeEach(async () => {
    vi.clearAllMocks();
    state = await createOpenClawTestState({
      label: "provider-discovery-scope",
      env: Object.fromEntries(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "CODEX_API_KEY", "CODEX_HOME", "GOOGLE_CLOUD_API_KEY"]
          .filter((key) => key !== "VITEST" && key !== "NODE_ENV")
          .map((key) => [key, undefined]),
      ),
    });
    // Missing explicit home fields must never reach the operator's OS home.
    // The sentinel keeps a failing isolation regression inside this disposable fixture.
    ambientHome = vi.spyOn(os, "homedir").mockReturnValue(state.path("ambient-home-sentinel"));
    mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([createProvider("openai")]);
    mocks.runProviderCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.runProviderStaticCatalog.mockResolvedValue({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [],
        },
      },
    });
    mocks.prepareProviderStaticCatalog.mockResolvedValue({
      providers: [],
      entries: [],
    });
  });

  afterEach(async () => {
    try {
      expect(ambientHome).not.toHaveBeenCalled();
    } finally {
      try {
        await state.cleanup();
      } finally {
        ambientHome.mockRestore();
      }
    }
  });

  it.each(["aliases", "hookAliases"] as const)(
    "captures configured membership from provider %s while retaining discovered rows",
    async (aliasKind) => {
      const configuredProviderModelIds = new Map<string, readonly string[]>();
      const provider = { ...createProvider("canonical"), [aliasKind]: ["alias"] };
      mocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
      mocks.runProviderCatalog.mockResolvedValue({
        providers: {
          canonical: {
            baseUrl: "https://canonical.invalid/v1",
            api: "openai-completions",
            models: [createTextModel("discovered", "Discovered")],
          },
        },
      });
      const explicitProvider = {
        baseUrl: "https://canonical.invalid/v1",
        api: "openai-completions" as const,
        models: [createTextModel("manual", "Manual")],
      };
      const providers = await resolveImplicitProviders({
        agentDir: state.agentDir(),
        env: state.env,
        config: {
          agents: { entries: { selected: { modelPolicy: { allow: ["canonical/*"] } } } },
          models: { providers: { alias: explicitProvider } },
        },
        explicitProviders: { alias: explicitProvider },
        providerCatalogInventory: { agentId: "selected", configuredProviderModelIds },
      });
      expect(configuredProviderModelIds).toEqual(new Map([["canonical", ["manual"]]]));
      expect(providers?.canonical?.models.map(({ id }) => id)).toEqual(["manual", "discovered"]);
    },
  );
});
