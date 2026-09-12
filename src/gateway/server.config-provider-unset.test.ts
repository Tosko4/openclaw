import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("config.patch preserves a provider declaration after its last fields are removed until the provider is removed", async () => {
  const state = await createOpenClawTestState({
    label: "config-provider-unset",
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
  const hotReloadRecovery = vi.fn(() => {
    throw new Error("Provider field removal unexpectedly required a recovery restart");
  });
  const token = "provider-unset-gateway-token";
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    models: {
      providers: {
        "amazon-bedrock": {
          baseUrl: "https://provider.example.invalid/v1",
          models: [],
          headers: { Authorization: "synthetic-header" },
        },
      },
    },
    plugins: { enabled: false },
    gateway: { mode: "local", auth: { mode: "token", token } },
  };
  try {
    await state.writeConfig(cfg);
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
      hotReloadRecovery,
    });
    try {
      await server.startupSettled;
      const patch = async (provider: Record<string, null> | null, replacePaths?: string[]) => {
        const current = await client.request<{ hash: string }>("config.get", {});
        await client.request("config.patch", {
          baseHash: current.hash,
          raw: JSON.stringify({ models: { providers: { "amazon-bedrock": provider } } }),
          replacePaths,
        });
        return JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      };

      const withoutFields = await patch({ baseUrl: null, models: null, headers: null }, [
        "models.providers.amazon-bedrock.models",
      ]);

      expect(withoutFields.models?.providers?.["amazon-bedrock"]).toEqual({});

      const withoutProvider = await patch(null, ["models.providers.amazon-bedrock.models"]);

      expect(withoutProvider.models?.providers?.["amazon-bedrock"]).toBeUndefined();
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    await state.cleanup();
  }
});
