import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import { saveModelProviderApiKey } from "../../commands/models/auth-api-key.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";

async function runFamilyOrderCase(mode: "explicit" | "retained") {
  const state = await createOpenClawTestState({
    label: `${mode}-family-auth-order`,
    layout: "state-only",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      BYTEPLUS_API_KEY: undefined,
    },
  });
  const familyKey = "family-order-fixture-key";
  const exactKey = "exact-plan-fixture-key";
  const acceptedKeys = mode === "retained" ? [familyKey, exactKey] : [familyKey];
  const catalogRequests: Array<{ authorization: string; apiKey: string }> = [];
  const inferenceRequests: Array<{ authorization: string; model: string }> = [];
  const endpointErrors: unknown[] = [];
  const endpoint = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    if (request.method === "GET" && request.url === "/models") {
      const apiKey = String(request.headers["x-api-key-resolver"] ?? "");
      catalogRequests.push({ authorization, apiKey });
      if (!acceptedKeys.some((key) => authorization === `Bearer ${key}` && apiKey === key)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: "plan-model", name: "Plan model" }]));
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
      if (!acceptedKeys.some((key) => authorization === `Bearer ${key}`)) {
        response.writeHead(403).end();
        return;
      }
      writeOpenAiResponsesText(response, {
        text: "EXPLICIT_FAMILY_ORDER_OK",
        messageId: "family-order-message",
        responseId: "family-order-response",
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
      throw new Error("Family-order fixture did not bind a TCP port");
    }
    const endpointUrl = `http://127.0.0.1:${address.port}`;
    const providerConfig: ModelProviderConfig = {
      baseUrl: `${endpointUrl}/v1`,
      api: "openai-responses",
      request: { allowPrivateNetwork: true },
      models: [
        {
          id: "plan-model",
          name: "Plan model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
    };
    await state.writeJson("byteplus-plugin/openclaw.plugin.json", {
      id: "byteplus",
      providers: ["byteplus", "byteplus-plan"],
      providerAuthAliases: { "byteplus-plan": "byteplus" },
      modelCatalog: {
        providers: { "byteplus-plan": providerConfig },
        discovery: { "byteplus-plan": "refreshable" },
      },
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "byteplus-plugin/index.cjs",
      `module.exports = {
        id: "byteplus", register(api) {
          const provider = require("./openclaw.plugin.json").modelCatalog.providers["byteplus-plan"];
          api.registerProvider({
            id: "byteplus-plan", label: "BytePlus Plan fixture", auth: [],
            staticCatalog: { order: "simple", run: () => ({ provider }) },
            catalog: { order: "profile", async run(ctx) {
              const auth = ctx.resolveProviderAuth("byteplus-plan");
              const key = ctx.resolveProviderApiKey("byteplus-plan");
              if (!auth.discoveryApiKey || !key.discoveryApiKey) return null;
              const response = await fetch(${JSON.stringify(`${endpointUrl}/models`)}, {
                headers: {
                  Authorization: "Bearer " + auth.discoveryApiKey,
                  "X-API-Key-Resolver": key.discoveryApiKey,
                },
              });
              if (!response.ok) throw new Error("Explicit family catalog account was rejected");
              const rows = await response.json();
              return { provider: {
                ...provider, models: rows.map(row => ({ ...provider.models[0], ...row })),
              } };
            } },
          });
        },
      };`,
    );
    const token = "explicit-family-order-gateway-token";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: { primary: "byteplus-plan/plan-model", fallbacks: [] },
          modelPolicy: { allow: ["byteplus-plan/*"] },
          models: { "byteplus-plan/plan-model": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      plugins: { allow: ["byteplus"], load: { paths: [pluginPath] }, slots: { memory: "none" } },
      tools: { profile: "minimal" },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "byteplus:family": { type: "api_key", provider: "byteplus", key: familyKey },
        ...(mode === "explicit"
          ? {
              "byteplus-plan:saved": {
                type: "api_key" as const,
                provider: "byteplus-plan",
                key: exactKey,
              },
            }
          : {}),
      },
      ...(mode === "explicit" ? { order: { byteplus: ["byteplus:family"] } } : {}),
    });
    const hotReloadRecovery = vi.fn(() => {
      throw new Error("Saving the exact-provider account unexpectedly required a recovery restart");
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
      const listed = await client.request<ModelsListResult>("models.list", {
        agentId: "main",
        provider: "byteplus-plan",
        view: "all",
        refresh: true,
      });
      expect
        .soft(listed.models)
        .toContainEqual(
          expect.objectContaining({ provider: "byteplus-plan", id: "plan-model", available: true }),
        );
      expect
        .soft(new Set(catalogRequests.map((request) => JSON.stringify(request))))
        .toEqual(
          new Set([JSON.stringify({ authorization: `Bearer ${familyKey}`, apiKey: familyKey })]),
        );
      const status = await client.request<ModelAuthStatusResult>("models.authStatus", {
        agentId: "main",
      });
      expect.soft(status.servingAuth?.models).toContainEqual(
        expect.objectContaining({
          provider: "byteplus-plan",
          model: "plan-model",
          availability: true,
          selectedProfileId: "byteplus:family",
        }),
      );
      const turn = async () => {
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          agentId: "main",
          sessionKey: `agent:main:${mode}-family-order`,
          message: "Reply with EXPLICIT_FAMILY_ORDER_OK only.",
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
      expect(await turn()).toMatchObject({ status: "ok" });
      const expectedRequest = { authorization: `Bearer ${familyKey}`, model: "plan-model" };
      expect(inferenceRequests).toEqual([expectedRequest]);

      if (mode === "retained") {
        expect(
          await saveModelProviderApiKey({
            config: cfg,
            provider: "byteplus-plan",
            profileId: "byteplus-plan:saved",
            apiKey: exactKey,
            agentDir: state.agentDir(),
          }),
        ).toBe("byteplus-plan:saved");
        await expect(
          client.request("models.authRefresh", { agentId: "main", operation: "login" }),
        ).resolves.toEqual({ refreshed: true });
        const saved = await client.request<{ config: OpenClawConfig }>("config.get", {});
        expect(saved.config.auth?.order).toBeUndefined();
        expect(saved.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
        const serving = await client.request<ModelAuthStatusResult>("models.authStatus", {
          agentId: "main",
        });
        expect.soft(serving.servingAuth?.models).toContainEqual(
          expect.objectContaining({
            provider: "byteplus-plan",
            model: "plan-model",
            availability: true,
            selectedProfileId: "byteplus:family",
          }),
        );
        const nextTurn = await turn();
        expect.soft(nextTurn, JSON.stringify(nextTurn)).toMatchObject({ status: "ok" });
        expect(inferenceRequests).toEqual([expectedRequest, expectedRequest]);
      }
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      expect(endpointErrors).toEqual([]);
    } finally {
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
    });
    await state.cleanup();
  }
}

it("models.list, models.authStatus, and agent honor explicit family order with an exact-provider account present", async () => {
  await runFamilyOrderCase("explicit");
});

it("keeps the working family account after saving an exact-provider account between automatic Plan turns", async () => {
  await runFamilyOrderCase("retained");
});
