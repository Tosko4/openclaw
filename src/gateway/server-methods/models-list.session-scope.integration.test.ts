import { once } from "node:events";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as modelTransport from "../../agents/provider-transport-fetch.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  connectUserModelAccount,
  updateUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it("models.list acquires each requested provider once without widening session-only admission", async () => {
  const state = await createOpenClawTestState({
    label: "models-list-session-scope",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      SCOPED_ALTERNATE_ACCOUNT: "other-alternate",
    },
  });
  const family = "scope-family";
  const selectedFamily = "scope-family-plan";
  const other = "scope-other";
  const providers = [family, selectedFamily, other];
  const requests: string[] = [];
  const personalRequests: string[] = [];
  const sharedPinnedRequests: string[] = [];
  const personalStarted = createDeferred();
  const replacementStarted = createDeferred();
  let releasePersonal: (() => void) | undefined;
  let holdPersonal = false;
  const inferenceRequests: Array<{
    authorization: string | undefined;
    model: string;
    maxTokens?: number;
  }> = [];
  const endpoint = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      void text(request).then((raw) => {
        const body = JSON.parse(raw) as {
          model: string;
          max_tokens?: number;
          max_completion_tokens?: number;
        };
        inferenceRequests.push({
          authorization: request.headers.authorization,
          model: body.model,
          maxTokens: body.max_tokens ?? body.max_completion_tokens,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "session-catalog-turn",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "SESSION_CATALOG_OK" },
                finish_reason: "stop",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      return;
    }
    const provider = request.url?.slice(1);
    const personalKey = request.headers.authorization;
    if (
      provider === other &&
      (personalKey === "Bearer personal-key" ||
        personalKey === "Bearer personal-replaced" ||
        personalKey === "Bearer other-alternate")
    ) {
      if (personalKey === "Bearer other-alternate") {
        sharedPinnedRequests.push(personalKey);
      } else {
        personalRequests.push(personalKey);
      }
      if (personalKey === "Bearer personal-replaced") {
        replacementStarted.resolve();
      }
      const send = () => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify([
            { id: "selected", maxTokens: 8192 },
            {
              id:
                personalKey === "Bearer other-alternate"
                  ? "shared-pin-only"
                  : personalKey === "Bearer personal-key"
                    ? "private-only"
                    : "private-after",
            },
          ]),
        );
      };
      if (holdPersonal && personalKey === "Bearer personal-key") {
        releasePersonal = send;
        personalStarted.resolve();
      } else {
        send();
      }
      return;
    }
    const key = provider === other ? "other-key" : "family-key";
    if (
      !provider ||
      !providers.includes(provider) ||
      request.headers.authorization !== `Bearer ${key}`
    ) {
      response.writeHead(401).end();
      return;
    }
    requests.push(provider);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ id: "selected" }, { id: "account-only" }]));
  });
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Session catalog fixture did not bind a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await state.writeJson("catalog-plugin/openclaw.plugin.json", {
      id: "scope-catalog",
      providers,
      providerAuthAliases: { [selectedFamily]: family },
      modelCatalog: {
        discovery: Object.fromEntries(providers.map((provider) => [provider, "refreshable"])),
      },
      configSchema: { type: "object", additionalProperties: false },
    });
    const pluginPath = await state.writeText(
      "catalog-plugin/index.cjs",
      `module.exports = {
        id: "scope-catalog",
        register(api) {
          for (const provider of ${JSON.stringify(providers)}) {
            api.registerProvider({
              id: provider, label: provider, auth: [],
              catalog: { order: "profile", async run(ctx) {
                const auth = ctx.resolveProviderAuth(provider);
                if (!auth.discoveryApiKey) return null;
                const response = await fetch(${JSON.stringify(baseUrl)} + "/" + provider, {
                  headers: { Authorization: "Bearer " + auth.discoveryApiKey },
                });
                if (!response.ok) throw new Error("Fixture account rejected");
                const rows = await response.json();
                return { provider: {
                  baseUrl: ${JSON.stringify(`${baseUrl}/v1`)}, api: "openai-completions",
                  models: rows.map((row) => ({ ...row, name: row.id, reasoning: false,
                    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768, maxTokens: row.maxTokens ?? 4096 })),
                } };
              } },
            });
          }
        },
      };`,
    );
    const token = "session-scope-gateway-token";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skipBootstrap: true,
          heartbeat: { every: "0m" },
          model: `${other}/selected`,
          modelPolicy: { allow: providers.map((provider) => `${provider}/*`) },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      tools: { profile: "minimal" },
      auth: { order: { [other]: ["other:saved"] } },
      plugins: {
        allow: ["scope-catalog"],
        load: { paths: [pluginPath] },
        slots: { memory: "none" },
      },
      gateway: { mode: "local", auth: { mode: "token", token } },
    };
    await state.writeConfig(cfg);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "family:saved": { type: "api_key", provider: family, key: "family-key" },
        "other:saved": { type: "api_key", provider: other, key: "other-key" },
        "other:alternate": {
          type: "api_key",
          provider: other,
          keyRef: { source: "env", provider: "default", id: "SCOPED_ALTERNATE_ACCOUNT" },
        },
      },
    });
    const person = ensureProfileForEmail("catalog-person@example.test");
    const personal = connectUserModelAccount({
      ownerProfileId: person.id,
      credential: { type: "api_key", provider: other, key: "personal-key" },
      assertCurrent() {},
    });
    for (const provider of [selectedFamily, other]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: `agent:main:${provider}` },
        {
          sessionId: provider,
          updatedAt: 1,
          providerOverride: provider,
          modelOverride: "selected",
          modelOverrideSource: "user",
        },
      );
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:private-catalog" },
      {
        sessionId: "private-catalog",
        updatedAt: 1,
        providerOverride: other,
        modelOverride: "selected",
        modelOverrideSource: "user",
        authProfileOverride: personal.authProfileId,
        authProfileOverrideSource: "user",
      },
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:shared-account-pin" },
      {
        sessionId: "shared-account-pin",
        updatedAt: 1,
        providerOverride: other,
        modelOverride: "selected",
        modelOverrideSource: "user",
        authProfileOverride: "other:alternate",
        authProfileOverrideSource: "user",
      },
    );
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    // Permit only this recording endpoint at the existing network boundary; adding a
    // provider request policy to config would itself admit the session-only provider.
    const transport = vi
      .spyOn(modelTransport, "buildGuardedModelFetch")
      .mockImplementation((model) => {
        expect([selectedFamily, other]).toContain(model.provider);
        return async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          expect(url).toBe(`${baseUrl}/v1/chat/completions`);
          return fetch(input, init);
        };
      });
    try {
      await server.startupSettled;
      await client.request("models.list", { agentId: "main", view: "all", refresh: true });
      for (const sessionProvider of [selectedFamily, other]) {
        for (const provider of [other, selectedFamily, undefined]) {
          const offset = requests.length;
          const result = await client.request<ModelsListResult>("models.list", {
            sessionKey: `agent:main:${sessionProvider}`,
            view: "all",
            includeDetails: true,
            refresh: true,
            ...(provider ? { provider } : {}),
          });
          const admitted = sessionProvider === selectedFamily ? providers : [family, other];
          const expected = provider
            ? admitted.filter((candidate) => candidate === provider)
            : admitted;
          expect.soft(requests.slice(offset).toSorted()).toEqual(expected.toSorted());
          for (const requested of expected) {
            expect.soft(result.models).toContainEqual(
              expect.objectContaining({
                provider: requested,
                id: "account-only",
                available: true,
              }),
            );
          }
          if (provider) {
            expect.soft(result.models.every((entry) => entry.provider === provider)).toBe(true);
          }
          if (sessionProvider === selectedFamily && provider === selectedFamily) {
            const accepted = await client.request<{ runId: string; status: string }>("agent", {
              agentId: "main",
              sessionKey: `agent:main:${selectedFamily}`,
              message: "Reply with SESSION_CATALOG_OK only.",
              deliver: false,
              idempotencyKey: "session-only-catalog-turn",
            });
            expect(accepted.status).toBe("accepted");
            const completed = await client.request<{ status: string }>(
              "agent.wait",
              {
                runId: accepted.runId,
                timeoutMs: 30_000,
              },
              { timeoutMs: 35_000 },
            );
            expect.soft(completed).toMatchObject({ status: "ok" });
            expect
              .soft(inferenceRequests)
              .toEqual([
                { authorization: "Bearer family-key", model: "selected", maxTokens: 4096 },
              ]);
          }
        }
      }
      const beforePassive = requests.length;
      const unscoped = await client.request<ModelsListResult>("models.list", {
        agentId: "main",
        view: "all",
        includeDetails: true,
      });
      expect(requests).toHaveLength(beforePassive);
      expect(unscoped.models).not.toContainEqual(
        expect.objectContaining({ provider: selectedFamily, available: true }),
      );
      const privateParams = {
        sessionKey: "agent:main:private-catalog",
        provider: other,
        view: "all",
        includeDetails: true,
        refresh: true,
      } as const;
      const privateResult = await client.request<ModelsListResult>("models.list", privateParams);
      expect(privateResult.models).toContainEqual(
        expect.objectContaining({ provider: other, id: "private-only", available: true }),
      );
      expect(personalRequests).toEqual(["Bearer personal-key"]);
      const sharedPinResult = await client.request<ModelsListResult>("models.list", {
        ...privateParams,
        sessionKey: "agent:main:shared-account-pin",
      });
      expect(sharedPinResult.models).toContainEqual(
        expect.objectContaining({ provider: other, id: "shared-pin-only", available: true }),
      );
      expect(sharedPinnedRequests).toEqual(["Bearer other-alternate"]);
      const sharedAfterPrivate = await client.request<ModelsListResult>("models.list", {
        agentId: "main",
        view: "all",
        includeDetails: true,
      });
      expect(sharedAfterPrivate.models.some((entry) => entry.id.startsWith("private-"))).toBe(
        false,
      );
      expect(sharedAfterPrivate.models.some((entry) => entry.id === "shared-pin-only")).toBe(false);
      const afterPrivateTurn = await client.request<{ runId: string }>("agent", {
        agentId: "main",
        sessionKey: `agent:main:${selectedFamily}`,
        message: "Reply with SESSION_CATALOG_OK only.",
        deliver: false,
        idempotencyKey: "shared-after-private-catalog",
      });
      const afterPrivateResult = await client.request(
        "agent.wait",
        { runId: afterPrivateTurn.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(afterPrivateResult, JSON.stringify(afterPrivateResult)).toMatchObject({
        status: "ok",
      });
      expect(inferenceRequests).toEqual([
        { authorization: "Bearer family-key", model: "selected", maxTokens: 4096 },
        { authorization: "Bearer family-key", model: "selected", maxTokens: 4096 },
      ]);
      const sharedAccountTurn = await client.request<{ runId: string }>("agent", {
        agentId: "main",
        sessionKey: `agent:main:${other}`,
        message: "Reply with SESSION_CATALOG_OK only.",
        deliver: false,
        idempotencyKey: "shared-account-after-private-catalog",
      });
      expect(
        await client.request(
          "agent.wait",
          { runId: sharedAccountTurn.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).toMatchObject({ status: "ok" });
      expect(inferenceRequests.at(-1)).toEqual({
        authorization: "Bearer other-key",
        model: "selected",
        maxTokens: 4096,
      });
      holdPersonal = true;
      const privateRefresh = client.request<ModelsListResult>("models.list", privateParams);
      void privateRefresh.catch(() => {});
      await personalStarted.promise;
      updateUserModelAuthProfile(personal.authProfileId, (profile) => {
        profile.credential = {
          type: "api_key",
          provider: other,
          key: "personal-replaced",
        };
        return true;
      });
      await replacementStarted.promise;
      releasePersonal?.();
      const replacedPrivate = await privateRefresh;
      expect(replacedPrivate.models.some((entry) => entry.id === "private-only")).toBe(false);
      expect(replacedPrivate.models).toContainEqual(
        expect.objectContaining({ id: "private-after", available: true }),
      );
      expect(personalRequests).toEqual([
        "Bearer personal-key",
        "Bearer personal-key",
        "Bearer personal-replaced",
      ]);
      expect(cfg.models?.providers).toBeUndefined();
    } finally {
      transport.mockRestore();
      await disconnectGatewayClient(client);
      await server.close();
    }
  } finally {
    releasePersonal?.();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      endpoint.close((error) => (error ? reject(error) : resolve()));
    });
    await state.cleanup();
  }
}, 120_000);
