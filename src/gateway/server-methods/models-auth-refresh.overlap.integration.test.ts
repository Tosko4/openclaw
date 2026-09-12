import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RuntimeConfigWriteApplicationStatus } from "../../config/runtime-write-application.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as configReload from "../config-reload.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it("models.authRefresh keeps catalog publication held until an overlapping failed mutation releases it", async () => {
  const state = await createOpenClawTestState({
    label: "overlapping-auth-refresh",
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
  const firstEntered = createDeferred<void>();
  const secondEntered = createDeferred<void>();
  const releaseFirst = createDeferred<void>();
  const releaseSecond = createDeferred<RuntimeConfigWriteApplicationStatus>();
  const newCatalogEntered = createDeferred<void>();
  const heldCatalogReplies: Array<() => void> = [];
  const releaseCatalog = () => {
    for (const send of heldCatalogReplies.splice(0)) {
      send();
    }
  };
  const requests: string[] = [];
  const startReloader = configReload.startGatewayConfigReloader;
  let reconcileCalls = 0;
  vi.spyOn(configReload, "startGatewayConfigReloader").mockImplementation((options) => {
    const reloader = startReloader(options);
    return {
      ...reloader,
      reconcileExternalWrite: async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return reloader.reconcileExternalWrite();
        }
        if (reconcileCalls === 2) {
          secondEntered.resolve();
          return releaseSecond.promise;
        }
        return reloader.reconcileExternalWrite();
      },
    };
  });
  const endpoint = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    requests.push(authorization);
    if (
      request.url !== "/models" ||
      !["Bearer old-key", "Bearer new-key"].includes(authorization)
    ) {
      response.writeHead(401).end();
      return;
    }
    const send = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([{ id: authorization === "Bearer old-key" ? "old-row" : "new-row" }]),
      );
    };
    if (authorization === "Bearer new-key") {
      heldCatalogReplies.push(send);
      newCatalogEntered.resolve();
    } else {
      send();
    }
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Overlapping auth fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: "overlap-fixture",
      providers: ["overlap-fixture"],
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
      id: "overlap-fixture", register(api) {
        api.registerProvider({ id: "overlap-fixture", label: "Overlap fixture", auth: [],
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth("overlap-fixture");
            if (!auth.discoveryApiKey) return null;
            const response = await fetch(${JSON.stringify(`${baseUrl}/models`)}, {
              headers: { Authorization: "Bearer " + auth.discoveryApiKey },
            });
            if (!response.ok) throw new Error("Catalog rejected the account");
            const rows = await response.json();
            return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
              models: rows.map(row => ({ ...row, name: row.id, input: ["text"], reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768, maxTokens: 4096 })),
            } };
          } },
        });
      },
    };`,
    );
    const token = "overlap-fixture-gateway-token";
    const cfg = {
      agents: {
        defaults: { modelPolicy: { allow: ["overlap-fixture/*"] } },
        entries: { main: { workspace: state.workspaceDir } },
      },
      plugins: {
        allow: ["overlap-fixture"],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    const save = (key: string) =>
      state.writeAuthProfiles({
        version: 1,
        profiles: {
          "overlap-fixture:saved": { type: "api_key", provider: "overlap-fixture", key },
        },
      });
    await state.writeConfig(cfg);
    await save("old-key");
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    const operations: Promise<unknown>[] = [];
    try {
      await server.startupSettled;
      const list = (refresh = false) =>
        client.request<ModelsListResult>("models.list", {
          agentId: "main",
          provider: "overlap-fixture",
          view: "all",
          refresh,
        });
      expect((await list(true)).models.map((model) => model.id)).toEqual(["old-row"]);
      const first = client.request("models.authRefresh", { agentId: "main", operation: "update" });
      operations.push(first);
      void first.catch(() => undefined);
      await firstEntered.promise;
      await save("new-key");
      const second = client.request("models.authRefresh", { agentId: "main", operation: "update" });
      operations.push(second);
      const rejectedSecond = expect(second).rejects.toThrow("configuration application is failed");
      await secondEntered.promise;

      releaseFirst.resolve();
      await expect(first).resolves.toEqual({ refreshed: true });

      expect((await list()).pendingProviders ?? []).not.toContain("overlap-fixture");
      expect(requests).not.toContain("Bearer new-key");

      releaseSecond.resolve("failed");
      await rejectedSecond;
      await newCatalogEntered.promise;
      expect(requests.filter((authorization) => authorization === "Bearer new-key")).toHaveLength(
        1,
      );
      releaseCatalog();
      await expect
        .poll(async () => (await list()).models.map((model) => model.id))
        .toEqual(["new-row"]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve("failed");
      releaseCatalog();
      await Promise.allSettled(operations);
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
