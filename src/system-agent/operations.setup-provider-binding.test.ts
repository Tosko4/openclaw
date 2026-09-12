import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { getConfigProviderUseBindings } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../infra/state-migrations.receipts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  projectDefaultInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
} from "./inference-route.js";
import { executeSystemAgentOperation } from "./operations.js";
import { loadSystemAgentOverview } from "./overview.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

describe("openclaw.setup with a file-derived provider binding", () => {
  it("keeps the serving credential and prepares the workspace without persisting its runtime binding", async () => {
    await withOpenClawTestState(
      {
        label: "setup-provider-binding",
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
            new URL("../../extensions/", import.meta.url),
          ),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
          OPENCLAW_TEST_FAST: "1",
          BYTEPLUS_API_KEY: "fixture-byteplus-setup-key",
        },
      },
      async (state) => {
        const modelRef = "byteplus-plan/ark-code-latest";
        await state.writeConfig({
          agents: {
            defaults: { model: modelRef, workspace: state.workspaceDir },
            entries: { main: { default: true } },
          },
          gateway: { mode: "local", auth: { mode: "token", token: "fixture-gateway-token" } },
        });
        const before = await readConfigFileSnapshot();
        expect(before.valid).toBe(true);
        expect(before.sourceConfig.models?.providers).toBeUndefined();
        const beforeRuntime = before.runtimeConfig ?? before.config;
        expect(getConfigProviderUseBindings(beforeRuntime)).toEqual({
          "byteplus-plan": {
            apiKey: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
          },
        });
        const beforeRoute = await projectDefaultInferenceRoute(beforeRuntime);
        const credentials: Array<{ modelRef: string; apiKey: string | undefined }> = [];
        const recordServingCredential = async (config: OpenClawConfig) => {
          const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
          if (!route) {
            throw new Error("The selected setup route is missing");
          }
          const auth = await resolveApiKeyForProviderCore({
            provider: route.provider,
            cfg: route.runConfig,
            agentDir: route.agentDir,
            workspaceDir: state.workspaceDir,
            modelId: route.model,
            modelApi: "openai-completions",
            secretSentinels: false,
          });
          credentials.push({ modelRef: route.modelLabel, apiKey: auth.apiKey });
          return route.modelLabel;
        };
        const { runtime, lines } = createSystemAgentTestRuntime();

        const result = await executeSystemAgentOperation(
          { kind: "setup", workspace: state.workspaceDir },
          runtime,
          {
            approved: true,
            deps: {
              setupSurface: "gateway",
              loadOverview: () =>
                loadSystemAgentOverview({
                  deps: {
                    probeLocalCommand: async (command) => ({ command, found: false }),
                    probeGatewayUrl: async (url) => ({ url, reachable: true }),
                  },
                }),
              // The inference probe records the real credential resolver's choice;
              // config loading, setup, its route guards, and workspace writes stay real.
              verifyInferenceConfig: async ({ config }) => ({
                ok: true,
                modelRef: await recordServingCredential(config),
                latencyMs: 1,
              }),
            },
          },
        );

        expect(result).toMatchObject({ applied: true, bootstrapPending: true });
        const after = await readConfigFileSnapshot();
        expect(after.valid).toBe(true);
        expect(after.hash).not.toBe(before.hash);
        const afterRuntime = after.runtimeConfig ?? after.config;
        await recordServingCredential(afterRuntime);
        expect(credentials).toEqual([
          { modelRef, apiKey: "fixture-byteplus-setup-key" },
          { modelRef, apiKey: "fixture-byteplus-setup-key" },
        ]);
        expect((await projectDefaultInferenceRoute(afterRuntime)).route).toEqual(beforeRoute.route);
        expect(after.sourceConfig.models?.providers).toBeUndefined();
        expect(await fs.readFile(state.configPath, "utf8")).not.toContain("BYTEPLUS_API_KEY");
        expect(
          readLegacyMigrationReceipt(
            resolveLegacyMigrationSourceKey(
              "selected-shared-provider-bindings:v1",
              state.configPath,
            ),
            state.env,
          ),
        ).toBeNull();
        expect((await fs.stat(state.sessionsDir())).isDirectory()).toBe(true);
        expect(await fs.readFile(`${state.workspaceDir}/BOOTSTRAP.md`, "utf8")).not.toBe("");
        expect(lines.some((line) => line.startsWith("Workspace OK:"))).toBe(true);
        expect(lines).toContain(`Default model: ${modelRef} (verified and kept)`);
        expect(lines).toContain("[openclaw] done: openclaw.setup");
      },
    );
  });
});
