import { createApiRegistry } from "@openclaw/ai";
import { beforeEach, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

// Hoisted mocks keep Vitest module replacement stable while the implementation
// under test imports auth, model resolution, and transport helpers at module load.
const hoisted = vi.hoisted(() => ({
  acquireRuntimeLeaseMock: vi.fn(),
  resolveModelMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
  prepareProviderRuntimeAuthMock: vi.fn(),
  ensureAuthProfileStoreMock: vi.fn(),
  getCurrentPluginMetadataSnapshotMock:
    vi.fn<
      typeof import("../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
    >(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: hoisted.acquireRuntimeLeaseMock,
}));

vi.mock("../plugins/runtime/generation-scope.js", () => ({
  getPluginRuntimeGenerationRegistry: () => undefined,
  withPluginRuntimeGenerationScope: (_snapshot: unknown, run: () => unknown) => run(),
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  initializeModelRegistryRuntime: vi.fn(),
  getModelRegistryRuntime: () => {
    const apiRegistry = createApiRegistry();
    return {
      apiRegistry,
      llmRuntime: {
        registry: apiRegistry,
        completeSimple: vi.fn(),
        streamSimple: vi.fn(),
      },
    };
  },
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
  resolveModelAsync: hoisted.resolveModelAsyncMock,
}));

vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: hoisted.ensureAuthProfileStoreMock,
}));

vi.mock("./auth-profiles/usage.js", () => ({
  reconcileAuthProfileQuotaBlocks: vi.fn(async () => {}),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: hoisted.getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  formatMissingAuthError: vi.fn(
    (auth: { source: string; mode: string }, provider: string) =>
      `No API key resolved for provider "${provider}" (auth mode: ${auth.mode}, checked: ${auth.source}).`,
  ),
  getApiKeyForModelCore: hoisted.getApiKeyForModelMock,
  resolveApiKeyForProviderCore: hoisted.getApiKeyForModelMock,
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuthMock,
}));

import type { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";

export const completionConfig: OpenClawConfig = {
  models: {
    providers: Object.fromEntries(
      [
        "anthropic",
        "github-copilot",
        "local-openai",
        "amazon-bedrock",
        "amazon-bedrock-mantle",
        "ollama",
        "mistral",
      ].map((provider) => [provider, { baseUrl: "", models: [] }]),
    ),
  },
};

export let preparedModelRuntime: PreparedModelRuntimeSnapshot;

beforeEach(() => {
  hoisted.acquireRuntimeLeaseMock.mockReset();
  hoisted.resolveModelMock.mockReset();
  hoisted.resolveModelAsyncMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.prepareProviderRuntimeAuthMock.mockReset();
  hoisted.ensureAuthProfileStoreMock.mockReset();
  hoisted.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
  hoisted.getCurrentPluginMetadataSnapshotMock.mockReset();
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  preparedModelRuntime = {
    catalogOwner: undefined,
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/runtime-workspace",
    config: {},
    observationConfig: {},
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    activeProjectKeys: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
  hoisted.acquireRuntimeLeaseMock.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  });

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);

  hoisted.resolveModelMock.mockReturnValue({
    model: {
      provider: "anthropic",
      id: "claude-opus-4-6",
      api: "anthropic-messages",
    },
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    modelRegistry: {},
  });
  hoisted.resolveModelAsyncMock.mockImplementation((...args: unknown[]) =>
    Promise.resolve(hoisted.resolveModelMock(...args)),
  );
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    source: "env:TEST_API_KEY",
    mode: "api-key",
  });
  hoisted.prepareProviderRuntimeAuthMock.mockImplementation(
    async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            apiKey: "copilot-runtime-token",
            baseUrl: "https://api.individual.githubcopilot.com",
          }
        : undefined;
    },
  );
  hoisted.getCurrentPluginMetadataSnapshotMock.mockReturnValue(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "openai",
          modelCatalog: {
            providers: {
              openai: {
                defaultUtilityModel: "gpt-5.5",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
        },
      ],
    }),
  );
});

export function expectPreparedModelResult(
  result: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>,
): asserts result is Exclude<typeof result, { error: string }> {
  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
}

export function callArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

export function createOpenAIRouteModelResolver(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  baseUrl: string;
}) {
  return vi.fn<SimpleCompletionModelResolver>(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("Prepared model stores were not bound");
      }
      const configured = cfg?.models?.providers?.openai;
      return {
        model: makeProviderModelFixture({
          provider,
          id: modelId,
          api: configured?.api ?? params.api,
          baseUrl: configured?.baseUrl ?? params.baseUrl,
        }),
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
      };
    },
  );
}

export { hoisted };
