import { expect, test } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  reloadSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { getRuntimeConfig } from "../config/io.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  ModelAuthOrderSetResult,
  ModelAuthStatusResult,
} from "./server-methods/models-auth-status.types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

test.each(["main", "work"])(
  "models.authOrderSet keeps %s priority and Reset agent-owned",
  async (agentId) => {
    const state = await createOpenClawTestState({
      label: "models-auth-order",
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
    const token = "auth-order-integration-token";
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    const provider = "fixture";
    const initialOrder = ["fixture:first"];
    const updatedOrder = ["fixture:second", "fixture:first"];
    try {
      await state.writeConfig(cfg);
      writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
      reloadSharedAuthStoreOwnership(process.env);
      saveAuthProfileStore({
        version: 1,
        profiles: {
          "fixture:first": { type: "api_key", provider, key: "fixture-first" },
          "fixture:second": { type: "api_key", provider, key: "fixture-second" },
        },
        order: { [provider]: initialOrder },
      });
      const { client, server, port } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read"],
      });
      try {
        await server.startupSettled;
        const config = getRuntimeConfig();
        const agentDir = resolveAgentDir(config, agentId);
        const siblingDir = resolveAgentDir(config, agentId === "main" ? "work" : "main");
        for (const scope of ["operator.read", "operator.write"]) {
          const deniedClient = await connectGatewayClient({
            url: `ws://127.0.0.1:${port}`,
            token,
            scopes: [scope],
          });
          try {
            await expect(
              deniedClient.request("models.authOrderSet", {
                provider,
                profileIds: updatedOrder,
                agentId,
              }),
            ).rejects.toMatchObject({
              code: "FORBIDDEN",
              message: "missing scope: operator.admin",
            });
            expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
          } finally {
            await disconnectGatewayClient(deniedClient);
          }
        }
        const readStatus = async () => {
          const status = await client.request<ModelAuthStatusResult>("models.authStatus", {
            agentId,
          });
          return status.providers.find((entry) => entry.provider === provider);
        };
        const inheritedStatus = await readStatus();
        expect(inheritedStatus).toMatchObject({ profileOrder: initialOrder });
        expect(inheritedStatus?.profileOrderStored).not.toBe(true);
        const allowed = await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
          provider,
          profileIds: updatedOrder,
          agentId,
        });
        expect(allowed.warning).toBeUndefined();
        expect(await readStatus()).toMatchObject({
          profileOrder: updatedOrder,
          profileOrderStored: true,
        });
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toEqual(updatedOrder);
        expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(
          initialOrder,
        );
        expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
        const reset = await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
          provider,
          agentId,
        });
        expect(reset.warning).toBeUndefined();
        const afterReset = await readStatus();
        expect(afterReset?.profileOrder).toEqual(initialOrder);
        expect(afterReset?.profileOrderStored).not.toBe(true);
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
        expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(
          initialOrder,
        );
        expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
      } finally {
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      await state.cleanup();
    }
  },
);
