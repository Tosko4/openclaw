import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it.each([false, true])(
  "models.list learns native models after cold Gateway startup (provider credentials: %s)",
  async (withProviderCredentials) => {
    const state = await createOpenClawTestState({
      label: "native-catalog-lifecycle",
      layout: "state-only",
      env: {
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const provider = "native-lifecycle-fixture";
    const harness = "native-lifecycle-runtime";
    const requests: string[] = [];
    let nativeModelId = "native-account-only";
    let noteNativeRequested!: () => void;
    const nativeRequested = new Promise<void>((resolve) => {
      noteNativeRequested = resolve;
    });
    let holdOther = false;
    let noteOtherRequested!: () => void;
    const otherRequested = new Promise<void>((resolve) => {
      noteOtherRequested = resolve;
    });
    let releaseOther!: () => void;
    const otherReleased = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    let releaseNative!: () => void;
    const nativeReleased = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    const endpoint = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/native/models") {
        noteNativeRequested();
        void nativeReleased.then(() =>
          response.end(
            JSON.stringify([
              { provider, id: nativeModelId, name: "Native account model", nativeRuntime: harness },
            ]),
          ),
        );
      } else if (request.url === "/provider/models" || request.url === "/other/models") {
        const reply = () =>
          response.end(
            JSON.stringify([{ id: "provider-account", name: "Provider account model" }]),
          );
        if (holdOther && request.url === "/other/models") {
          noteOtherRequested();
          void otherReleased.then(reply);
        } else {
          reply();
        }
      } else {
        response.writeHead(404).end();
      }
    });
    const saveAccount = (access: string) =>
      state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`${provider}:primary`]: {
            type: "oauth",
            provider,
            accountId: "native-account",
            access,
            refresh: `${access}-refresh`,
            expires: Date.now() + 3_600_000,
          },
        },
      });
    try {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Native endpoint has no TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await state.writeJson("native-plugin/openclaw.plugin.json", {
        id: provider,
        providers: [provider, "unrelated-native-fixture"],
        cliBackends: [harness],
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        "native-plugin/index.cjs",
        `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) {
        const observed = new WeakSet();
        api.registerAgentHarness({
          id: ${JSON.stringify(harness)}, label: "Native fixture", authBootstrap: "harness",
          supports: () => ({ supported: true }), runAttempt: async () => ({ ok: false, error: "unused" }),
          async loadModelCatalog(params) {
            const response = await fetch(${JSON.stringify(`${baseUrl}/native/models`)});
            const rows = await response.json();
            observed.add(params.config);
            return rows;
          },
          readModelCatalogReadiness: params => observed.has(params.config) ? { accountType: "chatgpt" } : undefined,
        });
        for (const providerId of [${JSON.stringify(provider)}, "unrelated-native-fixture"]) api.registerProvider({
          id: providerId, label: "Native fixture", auth: [],
          formatApiKey: credential => credential.access,
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth(providerId);
            if (!auth.discoveryApiKey) return null;
            const response = await fetch(${JSON.stringify(baseUrl)} + (providerId === ${JSON.stringify(provider)} ? "/provider/models" : "/other/models"));
            return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions",
              models: (await response.json()).map(row => ({ ...row, reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })) } };
          } },
        });
      }
    };`,
      );
      const token = "native-lifecycle-gateway-token";
      const cfg = {
        agents: {
          defaults: {
            model: `${provider}/static-model`,
            modelPolicy: { allow: [`${provider}/*`] },
            models: { [`${provider}/static-model`]: { agentRuntime: { id: harness } } },
          },
          list: [{ id: "main", workspace: state.workspaceDir }],
        },
        models: {
          providers: {
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [{ id: "static-model", name: "Static model" }],
            },
            ...(withProviderCredentials
              ? {
                  "unrelated-native-fixture": {
                    baseUrl,
                    api: "openai-completions",
                    apiKey: "unrelated-native-key",
                    models: [],
                  },
                }
              : {}),
          },
        },
        plugins: {
          allow: [provider],
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
          entries: { [provider]: { enabled: true } },
        },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      if (withProviderCredentials) {
        await saveAccount("native-original");
      }
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const list = () =>
          client.request<ModelsListResult>("models.list", { agentId: "main", view: "all" });
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const nativeStarted = await Promise.race([
          nativeRequested.then(() => true),
          new Promise<boolean>((resolve) => {
            waitTimer = setTimeout(() => resolve(false), 15_000);
          }),
        ]);
        clearTimeout(waitTimer);
        const beforeReads = requests.length;
        const readStarted = performance.now();
        const pending = await Promise.all([list(), list()]);
        const pendingReadMs = performance.now() - readStarted;
        console.log(
          "NATIVE_LIFECYCLE_PENDING",
          JSON.stringify({ nativeStarted, pendingReadMs, requests, pending }),
        );
        expect.soft(nativeStarted).toBe(true);
        expect.soft(requests.filter((path) => path === "/native/models")).toHaveLength(1);
        expect(pendingReadMs).toBeLessThan(1_000);
        expect(requests).toHaveLength(beforeReads);
        for (const result of pending) {
          expect(result.models.some((row) => row.id === "static-model")).toBe(true);
          expect.soft(result.pendingProviders).toContain(provider);
        }
        releaseNative();
        await expect
          .poll(
            async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
            { timeout: 15_000 },
          )
          .toBe(true);
        if (withProviderCredentials) {
          const beforeUnrelated = requests.length;
          holdOther = true;
          const firstRefresh = client.request<ModelsListResult>("models.list", {
            agentId: "main",
            provider: "unrelated-native-fixture",
            view: "all",
            refresh: true,
          });
          await otherRequested;
          const secondRefresh = client.request<ModelsListResult>("models.list", {
            agentId: "main",
            provider: "unrelated-native-fixture",
            view: "all",
            refresh: true,
          });
          const concurrentReadStarted = performance.now();
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          const concurrentReadMs = performance.now() - concurrentReadStarted;
          expect(concurrentReadMs).toBeLessThan(1_000);
          const foregroundResults = await Promise.all([firstRefresh, secondRefresh]);
          for (const result of foregroundResults) {
            expect(result.pendingProviders).toContain("unrelated-native-fixture");
          }
          releaseOther();
          await expect
            .poll(async () => (await list()).pendingProviders ?? [], { timeout: 15_000 })
            .not.toContain("unrelated-native-fixture");
          expect(requests.slice(beforeUnrelated)).toEqual(["/other/models"]);
          console.log(
            "NATIVE_PROVIDER_REFRESH_CONTENTION",
            JSON.stringify({
              concurrentReadMs,
              foregroundResults,
              requests: requests.slice(beforeUnrelated),
            }),
          );
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          nativeModelId = "native-new-release";
          const beforeScoped = requests.length;
          await client.request("models.list", { agentId: "main", provider, refresh: true });
          expect(requests.slice(beforeScoped)).toEqual(["/provider/models", "/native/models"]);
          expect((await list()).models.find((row) => row.id === nativeModelId)?.available).toBe(
            true,
          );
          const beforeReloadNative = requests.filter((path) => path === "/native/models").length;
          const config = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: config.hash,
            raw: JSON.stringify({
              agents: { defaults: { modelPolicy: { allow: [`${provider}/*`, "unused/*"] } } },
            }),
          });
          await expect
            .poll(() => requests.filter((path) => path === "/native/models").length, {
              timeout: 15_000,
            })
            .toBe(beforeReloadNative + 1);
          await expect
            .poll(
              async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
              { timeout: 15_000 },
            )
            .toBe(true);
          const beforeRenewal = requests.length;
          await saveAccount("native-renewed");
          await client.request("models.authRefresh", { agentId: "main", operation: "update" });
          expect((await list()).models.some((row) => row.id === "provider-account")).toBe(true);
          await expect
            .poll(
              () =>
                requests.slice(beforeRenewal).filter((path) => path === "/native/models").length,
              { timeout: 15_000 },
            )
            .toBe(1);
          await expect
            .poll(
              async () => (await list()).models.find((row) => row.id === nativeModelId)?.available,
              { timeout: 15_000 },
            )
            .toBe(true);
          expect(
            requests.slice(beforeRenewal).filter((path) => path === "/native/models"),
          ).toHaveLength(1);
        }
        const settledRequests = requests.length;
        await Promise.all([list(), list(), list()]);
        expect(requests).toHaveLength(settledRequests);
        console.log(
          "NATIVE_LIFECYCLE_PROOF",
          JSON.stringify({ pendingReadMs, requests, pending, settled: await list() }),
        );
      } finally {
        releaseOther();
        releaseNative();
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      releaseOther();
      releaseNative();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        endpoint.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await state.cleanup();
    }
  },
  120_000,
);

it("models.list full refresh discovers an enabled provider without configured credentials", async () => {
  const state = await createOpenClawTestState({
    label: "credential-free-catalog",
    layout: "state-only",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const provider = "credential-free-fixture";
  let requests = 0;
  const endpoint = createServer((_request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "public-model",
          name: "Public model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ]),
    );
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Catalog endpoint has no TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      providers: [provider],
      providerCatalogEntry: "./provider-discovery.cjs",
      configSchema: { type: "object", additionalProperties: false },
    });
    await state.writeText(
      "catalog-plugin/provider-discovery.cjs",
      `module.exports = {
      id: ${JSON.stringify(provider)}, label: "Public fixture", auth: [],
      catalog: { order: "simple", async run() {
        const response = await fetch(${JSON.stringify(baseUrl)});
        return { provider: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions", models: await response.json() } };
      } },
    };`,
    );
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) { api.registerProvider(require("./provider-discovery.cjs")); }
    };`,
    );
    const token = "credential-free-gateway-token";
    const cfg = {
      agents: {
        defaults: { models: { [`${provider}/*`]: {} } },
        list: [{ id: "main", workspace: state.workspaceDir }],
      },
      plugins: {
        allow: [provider],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
        entries: { [provider]: { enabled: true } },
      },
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
      const list = (refresh = false) =>
        client.request<ModelsListResult>("models.list", { agentId: "main", view: "all", refresh });
      expect((await list()).models.some((row) => row.id === "public-model")).toBe(false);
      expect(requests).toBe(0);
      const refreshed = await list(true);
      console.log("FULL_CATALOG_WITHOUT_CREDENTIALS", JSON.stringify({ requests, refreshed }));
      expect(refreshed.models).toContainEqual(
        expect.objectContaining({ provider, id: "public-model" }),
      );
      expect(requests).toBe(1);
      expect((await list()).models).toContainEqual(
        expect.objectContaining({ provider, id: "public-model" }),
      );
      expect(requests).toBe(1);
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await state.cleanup();
  }
}, 120_000);
