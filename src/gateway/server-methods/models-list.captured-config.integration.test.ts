import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

const configuredBaseUrl = "https://fixture.invalid/v1";
const capturedBaseUrl = "http://127.0.0.1:9/v1";
const cases = [
  {
    mode: "merge",
    capturedBaseUrl: configuredBaseUrl,
    capturedId: "selected",
    pin: false,
    expectedBaseUrl: configuredBaseUrl,
    expectedIds: ["selected", "retained-only"],
  },
  {
    mode: "replace",
    capturedBaseUrl: configuredBaseUrl,
    capturedId: "selected",
    pin: false,
    expectedBaseUrl: configuredBaseUrl,
    expectedIds: ["selected"],
  },
  {
    mode: "merge",
    capturedBaseUrl,
    capturedId: "selected",
    pin: false,
    expectedBaseUrl: capturedBaseUrl,
    expectedIds: ["selected", "retained-only"],
  },
  {
    mode: "replace",
    capturedBaseUrl,
    capturedId: "selected",
    pin: false,
    expectedBaseUrl: configuredBaseUrl,
    expectedIds: ["selected"],
  },
  {
    mode: "merge",
    capturedBaseUrl,
    capturedId: "selected",
    pin: true,
    expectedBaseUrl: configuredBaseUrl,
    expectedIds: ["selected", "retained-only"],
  },
  {
    mode: "merge",
    capturedBaseUrl,
    capturedId: "Selected",
    pin: false,
    expectedBaseUrl: configuredBaseUrl,
    expectedIds: ["selected", "Selected", "retained-only"],
  },
] as const;

it.each(["merge", "replace"] as const)(
  "models.list and its prepared acquisition preserve captured rows and endpoint ownership in %s mode",
  async (mode) => {
    const state = await createOpenClawTestState({
      label: `captured-config-${mode}`,
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      },
    });
    const selectedCases = cases
      .filter((entry) => entry.mode === mode)
      .map((entry, index) => ({
        mode: entry.mode,
        capturedBaseUrl: entry.capturedBaseUrl,
        capturedId: entry.capturedId,
        pin: entry.pin,
        expectedBaseUrl: entry.expectedBaseUrl,
        expectedIds: entry.expectedIds,
        agentId: index === 0 ? "main" : `case-${index}`,
        provider: `captured-fixture-${index}`,
        workspace: state.statePath(`workspace-${index}`),
      }));
    const providers: Record<string, ModelProviderConfig> = {};
    try {
      for (const entry of selectedCases) {
        providers[entry.provider] = {
          api: "openai-completions",
          apiKey: "captured-config-fixture-key",
          baseUrl: configuredBaseUrl,
          models: [
            {
              id: "selected",
              name: "Configured selected",
              contextWindow: 32_000,
              maxTokens: 4096,
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...(entry.pin ? { baseUrl: configuredBaseUrl } : {}),
            },
          ],
        };
        const agentDir = state.agentDir(entry.agentId);
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              [entry.provider]: {
                api: "openai-completions",
                baseUrl: entry.capturedBaseUrl,
                models: [
                  {
                    id: entry.capturedId,
                    name: "Earlier selected",
                    contextWindow: 64_000,
                    maxTokens: 4096,
                    reasoning: false,
                    input: ["text", "image"],
                  },
                  {
                    id: "retained-only",
                    name: "Retained authored row",
                    contextWindow: 48_000,
                    maxTokens: 4096,
                    reasoning: false,
                    input: ["text", "image"],
                  },
                ],
              },
            },
          }),
        );
      }
      const token = `captured-config-${mode}-token`;
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { model: `${selectedCases[0]!.provider}/selected` },
          entries: Object.fromEntries(
            selectedCases.map((entry) => [
              entry.agentId,
              {
                workspace: entry.workspace,
                model: `${entry.provider}/selected`,
              },
            ]),
          ),
        },
        models: { mode, providers },
        plugins: { enabled: false },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        for (const entry of selectedCases) {
          const listed = await client.request<ModelsListResult>("models.list", {
            agentId: entry.agentId,
            provider: entry.provider,
            view: "all",
          });
          expect(listed.models.map((model) => model.id).toSorted()).toEqual(
            [...entry.expectedIds].toSorted(),
          );
          const acquired = await loadPreparedModelCatalogOwnerSnapshot({
            config: getRuntimeConfig(),
            agentId: entry.agentId,
            agentDir: state.agentDir(entry.agentId),
            workspaceDir: entry.workspace,
            readOnly: true,
          });
          const rows = acquired.modelCatalog.entries.filter(
            (model) => model.provider === entry.provider,
          );
          expect(rows.map((model) => model.id).toSorted()).toEqual(
            [...entry.expectedIds].toSorted(),
          );
          expect(rows.find((model) => model.id === "selected")).toMatchObject({
            name: "Configured selected",
            baseUrl: entry.expectedBaseUrl,
            contextWindow: 32_000,
            reasoning: true,
            input: ["text"],
          });
          expect(
            acquired.modelCatalog.routeVariants.filter(
              (model) => model.provider === entry.provider,
            ),
          ).toEqual(rows);
        }
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  },
);
