import { once } from "node:events";
import { createServer } from "node:http";
import { expect, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RuntimeConfigWriteApplicationStatus } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Deferred } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as configReload from "../config-reload.js";
import * as modelAuthRefresh from "../model-auth-refresh.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

type ReconcileHold = {
  entered: Deferred;
  release: Deferred<RuntimeConfigWriteApplicationStatus | "reconcile">;
};

export async function withAuthRefreshOverlap(
  run: (fixture: {
    client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"];
    requests: string[];
    save: (key: string, agentId?: string) => Promise<string>;
    list: (refresh?: boolean, agentId?: string) => Promise<ModelsListResult>;
    refresh: (agentId?: string) => Promise<unknown>;
    refreshCompletions: readonly Promise<void>[];
    holdReconcile: () => ReconcileHold;
    holdCatalog: () => { entered: Promise<void>; release: () => void };
    close: () => Promise<void>;
    start: () => Promise<void>;
    replacementWorkspace: string;
  }) => Promise<void>,
) {
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
  const reconciles: ReconcileHold[] = [];
  const pendingReconciles: ReconcileHold[] = [];
  const newCatalogEntered = createDeferred();
  let catalogHeld = false;
  const heldCatalogReplies: Array<() => void> = [];
  const releaseCatalog = () => {
    catalogHeld = false;
    for (const send of heldCatalogReplies.splice(0)) {
      send();
    }
  };
  const requests: string[] = [];
  const hotReloadRecovery = vi.fn(() => {
    throw new Error("Auth refresh fixture unexpectedly required a recovery restart");
  });
  const refreshCompletions: Promise<void>[] = [];
  const refreshModelAuth = modelAuthRefresh.refreshModelAuthStateAfterMutation;
  vi.spyOn(modelAuthRefresh, "refreshModelAuthStateAfterMutation").mockImplementation((...args) => {
    const completion = refreshModelAuth(...args);
    refreshCompletions.push(completion);
    void completion.catch(() => undefined);
    return completion;
  });
  const startReloader = configReload.startGatewayConfigReloader;
  vi.spyOn(configReload, "startGatewayConfigReloader").mockImplementation((options) => {
    const reloader = startReloader(options);
    return {
      ...reloader,
      reconcileExternalWrite: async () => {
        const hold = pendingReconciles.shift();
        if (!hold) {
          return reloader.reconcileExternalWrite();
        }
        hold.entered.resolve();
        const outcome = await hold.release.promise;
        return outcome === "reconcile" ? reloader.reconcileExternalWrite() : outcome;
      },
    };
  });
  const endpoint = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    requests.push(authorization);
    if (
      request.url !== "/models" ||
      !["Bearer old-key", "Bearer new-key", "Bearer other-key"].includes(authorization)
    ) {
      response.writeHead(401).end();
      return;
    }
    const send = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            id:
              authorization === "Bearer old-key"
                ? "old-row"
                : authorization === "Bearer other-key"
                  ? "other-row"
                  : "new-row",
          },
        ]),
      );
    };
    if (authorization === "Bearer new-key" && catalogHeld) {
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
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { modelPolicy: { allow: ["overlap-fixture/*"] } },
        entries: {
          pro: { workspace: state.workspaceDir },
          other: { workspace: state.statePath("other-workspace") },
        },
      },
      plugins: {
        allow: ["overlap-fixture"],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    const save = (key: string, agentId = "pro") =>
      state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            "overlap-fixture:saved": { type: "api_key", provider: "overlap-fixture", key },
          },
        },
        agentId,
      );
    await state.writeConfig(cfg);
    await save("old-key");
    await save("other-key", "other");
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let closingPromise: Promise<void> | undefined;
    const start = async () => {
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
        hotReloadRecovery,
      });
      await gateway.server.startupSettled;
    };
    const activeGateway = () => {
      if (!gateway) {
        throw new Error("Auth refresh fixture Gateway is closed");
      }
      return gateway;
    };
    const close = () =>
      (closingPromise ??= (async () => {
        const closing = activeGateway();
        await closing.server.close();
        await disconnectGatewayClient(closing.client);
        gateway = undefined;
        closingPromise = undefined;
      })());
    await start();
    const operations: Promise<unknown>[] = [];
    try {
      await run({
        get client() {
          return activeGateway().client;
        },
        requests,
        refreshCompletions,
        save,
        list: (refresh = false, agentId = "pro") =>
          activeGateway().client.request<ModelsListResult>("models.list", {
            agentId,
            provider: "overlap-fixture",
            view: "all",
            refresh,
          }),
        refresh: (agentId = "pro") => {
          const operation = activeGateway().client.request("models.authRefresh", {
            agentId,
            operation: "update",
          });
          operations.push(operation);
          void operation.catch(() => undefined);
          return operation;
        },
        holdReconcile: () => {
          const hold: ReconcileHold = {
            entered: createDeferred(),
            release: createDeferred(),
          };
          reconciles.push(hold);
          pendingReconciles.push(hold);
          return hold;
        },
        holdCatalog: () => {
          catalogHeld = true;
          return { entered: newCatalogEntered.promise, release: releaseCatalog };
        },
        close,
        start,
        replacementWorkspace: state.statePath("replacement-workspace"),
      });
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    } finally {
      for (const hold of reconciles) {
        hold.release.resolve("failed");
      }
      releaseCatalog();
      await Promise.allSettled(operations);
      await Promise.allSettled(refreshCompletions);
      if (gateway) {
        await close();
      }
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
    });
    vi.restoreAllMocks();
    await state.cleanup();
  }
}
