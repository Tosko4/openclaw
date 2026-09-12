import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { dualRoutes } from "../../agents/model-auth-availability.test-support.js";
import * as openaiRoutes from "../../agents/openai-model-routes.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import {
  bindModelRuntimeAuthSources,
  prepareModelRuntimeAuthSources,
  recordPreparedModelRuntimeAuthSource,
  retainModelRuntimeAuthSourcesAfterMutation,
  setPreparedModelRuntimeAuthStore,
} from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { ProviderModelAuthSource } from "../../agents/provider-model-auth-source-plan.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as providerUsage from "../../infra/provider-usage.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleStatusCommand } from "./commands-info.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

let state: OpenClawTestState;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

async function prepareStatusCommand(params: {
  provider: "openai" | "fixture-api";
  authStore?: AuthProfileStore;
  retainedSource?: ProviderModelAuthSource;
}) {
  state = await createOpenClawTestState({
    label: "registered-status-auth",
    env: { FIXTURE_API_KEY: "fake-environment-account" },
  });
  const runtime = params.provider === "openai" ? "codex" : "openclaw";
  const model = "gpt-5.4";
  const config: OpenClawConfig = {
    commands: { text: true },
    agents: {
      defaults: {
        model: `${params.provider}/${model}`,
        models: { [`${params.provider}/${model}`]: { agentRuntime: { id: runtime } } },
      },
      entries: { main: { workspace: state.workspaceDir } },
    },
    plugins: { entries: { codex: { enabled: true } } },
    ...(params.provider === "fixture-api"
      ? {
          models: {
            providers: { "fixture-api": { baseUrl: "https://fixture.invalid", models: [] } },
          },
        }
      : {}),
  };
  const entry = { provider: params.provider, id: model, name: "Status model" };
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    pluginRegistry: createEmptyPluginRegistry(),
    catalogOwner: { agentId: "main", workspaceDir: state.workspaceDir },
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
    activeProjectKeys: [],
    authModes: runtime === "codex" ? { codex: { source: "native", mode: "api_key" } } : {},
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] },
        {
          id: "fixture-api",
          providers: ["fixture-api"],
          setup: { providers: [{ id: "fixture-api", envVars: ["FIXTURE_API_KEY"] }] },
        },
      ],
    }),
    isCurrent: () => true,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      throw new Error("Status must not execute a model");
    },
  };
  setPreparedModelRuntimeAuthStore(owner, params.authStore ?? { version: 1, profiles: {} });
  if (params.retainedSource) {
    prepareModelRuntimeAuthSources(owner, undefined, owner);
    bindModelRuntimeAuthSources(owner, owner);
    recordPreparedModelRuntimeAuthSource(
      owner,
      params.provider,
      model,
      params.retainedSource,
      false,
    );
    retainModelRuntimeAuthSourcesAfterMutation(owner);
  }
  vi.spyOn(preparedCatalog, "getPreparedModelCatalogOwnerSnapshot").mockReturnValue(owner);
  vi.spyOn(providerUsage, "loadProviderUsageSummary").mockResolvedValue({
    updatedAt: 1,
    providers: [],
  });
  vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes);
  return async (sessionEntry?: SessionEntry) => {
    const command = buildCommandTestParams("/status", config, undefined, {
      workspaceDir: state.workspaceDir,
    });
    const result = await handleStatusCommand(
      { ...command, provider: params.provider, model, sessionEntry },
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    assert(result?.reply?.text);
    return result.reply.text;
  };
}

it.each(["user", "user-link"] as const)(
  "/status does not substitute native login for an unavailable %s profile",
  async (authProfileOverrideSource) => {
    const status = await prepareStatusCommand({ provider: "openai" });
    expect(await status()).toContain("api-key (codex)");

    const reply = await status({
      sessionId: "status-pin",
      updatedAt: 1,
      authProfileOverride: "openai:missing",
      authProfileOverrideSource,
      modelProvider: "openai",
    });

    expect(reply).toContain("openai/gpt-5.4");
    expect(reply).not.toContain("api-key (codex)");
  },
);

it.each(["new account", "expired account"] as const)(
  "/status reports the serving environment credential beside a %s",
  async (account) => {
    const status = await prepareStatusCommand({
      provider: "fixture-api",
      authStore: {
        version: 1,
        profiles: {
          "fixture-api:saved": {
            provider: "fixture-api",
            type: "token",
            token: "fake-saved-account",
            expires: account === "expired account" ? 1 : Date.now() + 60_000,
          },
        },
      },
      ...(account === "new account"
        ? {
            retainedSource: {
              kind: "direct",
              mode: "api-key",
              readiness: "ready",
              evidence: "environment",
              authorization: "ambient",
              boundEnvVar: "FIXTURE_API_KEY",
            } as const,
          }
        : {}),
    });

    const reply = await status();

    expect(reply).toContain("api-key (env: FIXTURE_API_KEY)");
    expect(reply).not.toContain("fake-environment-account");
    expect(reply).not.toContain("fake-saved-account");
  },
);
