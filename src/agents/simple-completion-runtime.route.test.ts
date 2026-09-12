import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import {
  callArg,
  createOpenAIRouteModelResolver,
  expectPreparedModelResult,
  hoisted,
} from "./simple-completion-runtime.test-support.js";

const { acquireSimpleCompletionModelForAgent } = await import("./simple-completion-runtime.js");

describe("acquireSimpleCompletionModelForAgent", () => {
  it("materializes a derived utility model on the Platform route for API-key auth", async () => {
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:platform": { type: "api_key", provider: "openai", key: "placeholder" },
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {},
          other: {},
        },
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      profileId: "openai:platform",
      source: "profile:openai:platform",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.selection.provider).toBe("openai");
      expect(result.selection.modelId).toBe("gpt-5.5");
      expect(result.model).toMatchObject({
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(modelResolver).toHaveBeenCalledTimes(2);
      expect(
        (callArg(hoisted.getApiKeyForModelMock, 0) as { model?: { api?: string } }).model?.api,
      ).toBe("openai-responses");
      // Route materialization re-resolves the model on a multi-agent config; both
      // calls must keep the authorized agentId or the second falls back to
      // resolveDefaultAgentId, which throws on a multi-agent config.
      expect(modelResolver.mock.calls[0]?.[4]).toMatchObject({ agentId: "main" });
      expect(modelResolver.mock.calls[1]?.[4]).toMatchObject({ agentId: "main" });
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });

  it.each(["mixed credentials", "same-route fallback", "pinned profile"])(
    "preserves subscription selection with %s",
    async (scenario) => {
      const authLookup = hoisted.getApiKeyForModelMock;
      const mixed = scenario === "mixed credentials";
      const pinned = scenario === "pinned profile";
      const oauth = {
        type: "oauth",
        provider: "openai",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 60_000,
      };
      hoisted.ensureAuthProfileStoreMock.mockReturnValue({
        version: 1,
        profiles: {
          "openai:ready": oauth,
          ...((mixed || pinned) && {
            "openai:platform": { type: "api_key", provider: "openai", key: "placeholder" },
          }),
          ...(!mixed && { "openai:expired": { ...oauth, expires: Date.now() - 60_000 } }),
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        ...(!mixed && !pinned
          ? { auth: { order: { openai: ["openai:expired", "openai:ready"] } } }
          : {}),
      };
      authLookup.mockImplementation(({ profileId }: { profileId?: string }) => {
        if (profileId === "openai:expired") {
          const failure = { provider: "openai", message: "Fixture refresh rejected" };
          throw pinned ? new Error(failure.message) : new OAuthRefreshFailureError(failure);
        }
        return {
          apiKey: "fixture-access",
          profileId: profileId ?? "openai:platform",
          source: `profile:${profileId ?? "openai:platform"}`,
          mode: profileId === "openai:ready" ? "oauth" : "api-key",
        };
      });
      const modelResolver = createOpenAIRouteModelResolver({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      const result = await acquireSimpleCompletionModelForAgent({
        cfg,
        agentId: "main",
        modelRef: `openai/gpt-5.5${pinned ? "@openai:expired" : ""}`,
        bindAuthOwner: pinned,
        skipAgentDiscovery: true,
        modelResolver,
      });
      try {
        if (pinned) {
          expect(result).toMatchObject({
            error: expect.stringContaining("Fixture refresh rejected"),
          });
        } else {
          expectPreparedModelResult(result);
          expect(result.selection.modelId).toBe("gpt-5.5");
          expect(result.auth.profileId).toBe("openai:ready");
          expect(result.model).toMatchObject({
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          });
        }
        expect(authLookup).toHaveBeenCalledTimes(mixed || pinned ? 1 : 2);
        expect(authLookup).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ profileId: mixed ? "openai:ready" : "openai:expired" }),
        );
        if (!mixed && !pinned) {
          expect(authLookup).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ profileId: "openai:ready" }),
          );
        }
      } finally {
        if (!("error" in result)) {
          await result[Symbol.asyncDispose]();
        }
      }
    },
  );

  it("keeps the Codex route for OAuth auth", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hoisted.ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "placeholder",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      profileId: "openai:chatgpt",
      source: "profile:openai:chatgpt",
      mode: "oauth",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-5.5",
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.selection.modelId).toBe("gpt-5.5");
      expect(result.model).toMatchObject({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      expect(modelResolver).toHaveBeenCalledTimes(1);
      expect(hoisted.getApiKeyForModelMock).toHaveBeenCalledTimes(1);
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });

  it("keeps an authored custom OpenAI route untouched", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "fixture-api-key",
            baseUrl: "https://relay.example/v1",
            models: [
              {
                id: "gpt-5.5",
                name: "Fixture model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-responses",
      baseUrl: "https://relay.example/v1",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      source: "models.providers.openai",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.model).toMatchObject({
        api: "openai-responses",
        baseUrl: "https://relay.example/v1",
      });
      expect(modelResolver).toHaveBeenCalledTimes(1);
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });

  it("honors an explicit model ref while selecting its auth-compatible route", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-6" } },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1", models: [], apiKey: "placeholder" },
        },
      },
    };
    const modelResolver = createOpenAIRouteModelResolver({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hoisted.getApiKeyForModelMock.mockResolvedValue({
      apiKey: "placeholder",
      source: "env:OPENAI_API_KEY",
      mode: "api-key",
    });

    const result = await acquireSimpleCompletionModelForAgent({
      cfg,
      agentId: "main",
      modelRef: "openai/gpt-5.5",
      skipAgentDiscovery: true,
      modelResolver,
    });

    try {
      expectPreparedModelResult(result);
      expect(result.selection).toMatchObject({ provider: "openai", modelId: "gpt-5.5" });
      expect(result.model).toMatchObject({ id: "gpt-5.5", api: "openai-responses" });
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
  });
});
