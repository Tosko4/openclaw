import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  applyAuthProfileConfig,
  upsertAuthProfileWithLockOrThrow,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import type { ModelAuthLogoutResult, ModelAuthStatusResult } from "./models-auth-status.types.js";

type CatalogInvalidation =
  | "removed"
  | "replaced"
  | "order"
  | "endpoint"
  | "plugin-disabled"
  | "empty"
  | "expired";

async function runRetainedCatalogScenario(invalidation?: CatalogInvalidation) {
  const state = await createOpenClawTestState({
    label: "retained-account-catalog",
    layout: "state-only",
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
  const provider = "retained-catalog-fixture";
  const model = "account-B-only";
  const accountA = "catalog-retention-A";
  const accountB = "catalog-retention-B";
  const accountBExpires = Date.now() + 3_600_000;
  const catalogRequests: string[] = [];
  const inferenceRequests: Array<{ authorization: string; model: string }> = [];
  const endpointErrors: unknown[] = [];
  let emptyAccountB = false;
  const endpoint = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (request.method === "GET" && request.url === "/models") {
      catalogRequests.push(authorization);
      const models =
        authorization === `Bearer ${accountB}` && !emptyAccountB
          ? [{ id: model, name: "Account B model" }]
          : authorization === `Bearer ${accountA}`
            ? [{ id: "account-A-only", name: "Account A model" }]
            : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(models));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
      inferenceRequests.push({ authorization, model: body.model });
      if (authorization !== `Bearer ${accountB}` || body.model !== model) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "This account does not own that model" } }),
        );
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "RETAINED_CATALOG_OK",
        messageId: `msg_${inferenceRequests.length}`,
        responseId: `resp_${inferenceRequests.length}`,
      });
    })().catch((error: unknown) => {
      endpointErrors.push(error);
      response.writeHead(500).end();
    });
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Retained catalog endpoint did not bind a TCP port");
    }
    const endpointUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: provider,
      providers: [provider],
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
        id: ${JSON.stringify(provider)}, register(api) {
          api.registerProvider({
            id: ${JSON.stringify(provider)}, label: "Retained catalog fixture", auth: [],
            catalog: { order: "profile", async run(ctx) {
              const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
              if (!auth.discoveryApiKey) return null;
              const response = await fetch(${JSON.stringify(`${endpointUrl}/models`)}, {
                headers: { Authorization: "Bearer " + auth.discoveryApiKey },
              });
              if (!response.ok) throw new Error("Account catalog failed");
              const models = await response.json();
              return { provider: {
                baseUrl: ${JSON.stringify(`${endpointUrl}/v1`)}, api: "openai-responses",
                models: models.map(row => ({ ...row, reasoning: false,
                  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768, maxTokens: 4096 })),
              }, ...(${JSON.stringify(invalidation === "empty")} && models.length === 0 ? {
                outcomes: [{ provider: ${JSON.stringify(provider)}, profileId: auth.profileId,
                  status: "ready" }],
              } : {}) };
            } },
          });
        },
      };`,
    );
    const token = "retained-catalog-gateway-token";
    const providerConfig: ModelProviderConfig = {
      baseUrl: `${endpointUrl}/v1`,
      api: "openai-responses",
      request: { allowPrivateNetwork: true },
      models: [],
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: `${provider}/${model}`, fallbacks: [] },
          modelPolicy: { allow: [`${provider}/*`] },
          models: { [`${provider}/${model}`]: { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      models: {
        providers: {
          [provider]: providerConfig,
        },
      },
      plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      tools: { profile: "minimal" },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "retained:B":
          invalidation === "expired"
            ? { type: "token", provider, token: accountB, expires: accountBExpires }
            : { type: "api_key", provider, key: accountB },
      },
    });
    const hotReloadRecovery = vi.fn(() => {
      throw new Error("Retained catalog fixture unexpectedly required a recovery restart");
    });
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      hotReloadRecovery,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      await server.startupSettled;
      const list = (refresh = false) =>
        client.request<ModelsListResult>("models.list", { agentId: "main", view: "all", refresh });
      const turn = async () => {
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          agentId: "main",
          sessionKey: "agent:main:retained-catalog",
          message: "Reply with RETAINED_CATALOG_OK only.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        return client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
      };
      expect((await list(true)).models).toContainEqual(
        expect.objectContaining({ provider, id: model, available: true }),
      );
      expect(await turn()).toMatchObject({ status: "ok" });
      expect(inferenceRequests).toEqual([{ authorization: `Bearer ${accountB}`, model }]);

      await upsertAuthProfileWithLockOrThrow({
        agentDir: state.agentDir(),
        profileId: "retained:A",
        credential: { type: "api_key", provider, key: accountA },
      });
      const savedConfig = applyAuthProfileConfig(cfg, {
        profileId: "retained:A",
        provider,
        mode: "api_key",
      });
      await state.writeConfig(savedConfig);
      await client.request("models.authRefresh", { agentId: "main", operation: "login" });
      await expect.poll(() => catalogRequests).toContain(`Bearer ${accountA}`);
      const refreshed = await list(true);
      expect(refreshed.models).toContainEqual(
        expect.objectContaining({ provider, id: "account-A-only" }),
      );
      expect
        .soft(refreshed.models)
        .toContainEqual(expect.objectContaining({ provider, id: model, available: true }));
      const serving = await client.request<ModelAuthStatusResult>("models.authStatus", {
        agentId: "main",
      });
      expect
        .soft(serving.servingAuth?.models)
        .toContainEqual(
          expect.objectContaining({ provider, model, selectedProfileId: "retained:B" }),
        );
      expect.soft(await turn()).toMatchObject({ status: "ok" });
      expect(inferenceRequests).toEqual([
        { authorization: `Bearer ${accountB}`, model },
        { authorization: `Bearer ${accountB}`, model },
      ]);
      const catalogRequestsBeforeInvalidation = catalogRequests.length;
      if (invalidation === "removed") {
        const logout = await client.request<ModelAuthLogoutResult>("models.authLogout", {
          agentId: "main",
          provider,
          profileIds: ["retained:B"],
        });
        expect(logout.removedProfiles).toEqual(["retained:B"]);
        expect(logout.warning).toBeUndefined();
      } else if (invalidation === "replaced") {
        await upsertAuthProfileWithLockOrThrow({
          agentDir: state.agentDir(),
          profileId: "retained:B",
          credential: { type: "api_key", provider, key: "replacement-account-B" },
        });
        await client.request("models.authRefresh", { agentId: "main", operation: "update" });
      } else if (invalidation === "order" || invalidation === "empty") {
        emptyAccountB = invalidation === "empty";
        const ordered = await client.request<{ warning?: string }>("models.authOrderSet", {
          agentId: "main",
          provider,
          profileIds:
            invalidation === "empty" ? ["retained:B", "retained:A"] : ["retained:A", "retained:B"],
        });
        expect(ordered.warning).toBeUndefined();
      } else if (invalidation === "endpoint") {
        await state.writeConfig({
          ...savedConfig,
          models: {
            ...savedConfig.models,
            providers: {
              [provider]: {
                ...providerConfig,
                baseUrl: `${endpointUrl}/replacement/v1`,
                models: [],
              },
            },
          },
        });
        await client.request("models.authRefresh", { agentId: "main", operation: "update" });
      } else if (invalidation === "plugin-disabled") {
        await state.writeConfig({
          ...savedConfig,
          plugins: { ...savedConfig.plugins, entries: { [provider]: { enabled: false } } },
        });
        await client.request("models.authRefresh", { agentId: "main", operation: "update" });
      } else if (invalidation === "expired") {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(accountBExpires + 1);
      }
      if (invalidation) {
        const invalidated = await list(true);
        expect(invalidated.refreshFailed).not.toBe(true);
        expect(invalidated.models).not.toContainEqual(
          expect.objectContaining({ provider, id: model }),
        );
        if (invalidation === "empty") {
          expect(catalogRequests.slice(catalogRequestsBeforeInvalidation)).toContain(
            `Bearer ${accountB}`,
          );
          expect(invalidated.providerOutcomes).toContainEqual(
            expect.objectContaining({ provider, profileId: "retained:B", status: "ready" }),
          );
        }
        expect(inferenceRequests).toHaveLength(2);
      }
      expect(endpointErrors).toEqual([]);
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    } finally {
      if (invalidation === "expired") {
        vi.useRealTimers();
      }
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => (error ? reject(error) : resolve()));
    });
    await state.cleanup();
  }
}

it("models.authRefresh keeps the working account's learned model through models.list and agent after another account is saved", async () => {
  await runRetainedCatalogScenario();
}, 120_000);

it.each([
  "removed",
  "replaced",
  "order",
  "endpoint",
  "plugin-disabled",
  "empty",
  "expired",
] as const)(
  "models.authRefresh retires the working account's learned model after %s",
  async (invalidation) => {
    await runRetainedCatalogScenario(invalidation);
  },
  120_000,
);
