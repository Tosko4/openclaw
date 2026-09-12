import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import * as gateway from "../../gateway/call.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCapturingTestRuntime } from "../test-runtime-config-helpers.js";
import { modelsStatusCommand } from "./list.status-command.js";

afterEach(() => vi.restoreAllMocks());

async function withStatusCommand(
  run: (fixture: { agentDir: string; status: () => Promise<unknown> }) => Promise<void>,
) {
  const state = await createOpenClawTestState({
    label: "models-status-gateway-source",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENAI_API_KEY: undefined },
  });
  try {
    await state.writeConfig({
      agents: {
        defaults: {
          model: "status-fixture/fixture-model",
          models: { "status-fixture/fixture-model": { agentRuntime: { id: "openclaw" } } },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      models: {
        providers: {
          "status-fixture": {
            api: "openai-responses",
            baseUrl: "https://status-fixture.invalid/v1",
            models: [
              {
                id: "fixture-model",
                name: "Status fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32768,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      plugins: { enabled: false },
    });
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "status-fixture:local": {
          type: "api_key",
          provider: "status-fixture",
          key: "local-status-fixture",
        },
      },
    });
    await run({
      agentDir: state.agentDir(),
      status: async () => {
        const { runtime, logs } = createCapturingTestRuntime();
        await modelsStatusCommand({ json: true, agent: "main" }, runtime);
        const output = logs.find((line) => line.startsWith("{"));
        assert(output);
        return JSON.parse(output);
      },
    });
  } finally {
    await state.cleanup();
  }
}

it.each(["same", "other-agent", "other-directory", "older", "offline"] as const)(
  "models status uses the running source only for the same local scope: %s",
  async (scope) => {
    await withStatusCommand(async ({ agentDir, status }) => {
      const call = vi.spyOn(gateway, "callGateway");
      if (scope === "offline") {
        call.mockRejectedValue(new Error("unreachable"));
      } else {
        call.mockResolvedValue({
          ts: 1,
          providers:
            scope === "older"
              ? [
                  {
                    provider: "status-fixture",
                    apiKey: { source: "env", envVar: "STATUS_FIXTURE_KEY" },
                  },
                ]
              : [],
          ...(scope === "older"
            ? {}
            : {
                servingAuth: {
                  agentId: scope === "other-agent" ? "other" : "main",
                  agentDir: scope === "other-directory" ? `${agentDir}/other` : agentDir,
                  models: [
                    {
                      provider: "status-fixture",
                      model: "fixture-model",
                      availability: false,
                      unavailableReason: "missing-auth",
                    },
                  ],
                },
              }),
        });
      }
      const result = await status();
      expect(result).toMatchObject({
        auth: { missingProvidersInUse: scope === "same" ? ["status-fixture"] : [] },
      });
      if (scope === "older") {
        expect(result).toMatchObject({
          auth: {
            providers: expect.arrayContaining([
              expect.objectContaining({
                provider: "status-fixture",
                effective: expect.objectContaining({ kind: "profiles" }),
              }),
            ]),
          },
        });
      }
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "models.authStatus",
          params: { agentId: "main" },
          requireLocalBackendSharedAuth: true,
          sharedStateMode: "read-only",
        }),
      );
    });
  },
);

it.each([
  "gateway timeout after 3000ms",
  "gateway closed (1006): connection lost",
  "Auth preparation pending",
  "Serving auth changed",
])("models status refuses to guess local auth after a serving failure: %s", async (message) => {
  await withStatusCommand(async ({ status }) => {
    vi.spyOn(gateway, "callGateway").mockImplementation(async (options) => {
      if (message === "Auth preparation pending") {
        return {
          ts: 1,
          providers: [],
          unavailable: {
            code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
            message,
          },
        };
      }
      if (message === "Serving auth changed") {
        throw new GatewayClientRequestError({ code: "UNAVAILABLE", message });
      }
      options.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "test", connId: "status-fixture" },
        features: { capabilities: [], methods: ["models.authStatus"], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      });
      throw new Error(message);
    });
    await expect(status()).rejects.toThrow(message);
  });
});
