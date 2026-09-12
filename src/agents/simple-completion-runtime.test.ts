// Simple completion runtime tests cover model resolution, provider auth, and
// one-shot completion wiring before requests reach the shared LLM stream path.
import { describe, expect, it, vi } from "vitest";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "./execution-auth-binding.js";
import {
  callArg,
  completionConfig,
  createOpenAIRouteModelResolver,
  expectPreparedModelResult,
  hoisted,
  preparedModelRuntime,
} from "./simple-completion-runtime.test-support.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

const { prepareSimpleCompletionModel } = await import("./simple-completion-runtime.js");

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/runtime-workspace",
      modelResolver: hoisted.resolveModelAsyncMock as SimpleCompletionModelResolver,
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-opus-4-6");
    expect(result.auth.mode).toBe("api-key");
    expect(result.auth.source).toBe("env:TEST_API_KEY");
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      workspaceDir: "/tmp/runtime-workspace",
    });
  });

  it("captures the exact locked auth owner used by a bound completion", async () => {
    const credential = {
      type: "api_key" as const,
      provider: "anthropic",
      key: "sk-p2",
    };
    const store = { version: 1, profiles: { "anthropic:p2": credential } };
    hoisted.ensureAuthProfileStoreMock.mockReturnValueOnce(store);
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "sk-p2",
      profileId: "anthropic:p2",
      source: "profile:anthropic:p2",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: {},
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/openclaw-agent",
      profileId: "anthropic:p2",
      bindAuthOwner: true,
    });

    expectPreparedModelResult(result);
    expect(result.sourceAuthFingerprint).toBe(
      fingerprintResolvedProviderAuth({
        apiKey: "sk-p2",
        profileId: "anthropic:p2",
        source: "profile:anthropic:p2",
        mode: "api-key",
      }),
    );
    expect(hoisted.getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:p2",
        lockedProfile: true,
        store,
      }),
    );
  });

  it("keeps a bound personal OAuth owner stable across token rotation", async () => {
    const profileId =
      "personal:9ee1b53f-13f7-4d21-b0a1-2b539ab4fd1d:5b99e716-6cea-49f2-a79e-ffb6df8ad5e1";
    let credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "access-before-refresh",
      refresh: "refresh-before",
      expires: Date.now() + 60_000,
      accountId: "workspace",
    };
    hoisted.ensureAuthProfileStoreMock.mockImplementation(
      (_agentDir: string, options?: { profileId?: string }) => ({
        version: 1,
        profiles: options?.profileId === profileId ? { [profileId]: credential } : {},
      }),
    );
    hoisted.getApiKeyForModelMock.mockImplementation(async () => ({
      apiKey: credential.access,
      profileId,
      source: `profile:${profileId}`,
      mode: "oauth",
    }));
    const params = {
      cfg: {},
      provider: "openai",
      modelId: "gpt-5.5",
      profileId,
      bindAuthOwner: true,
      modelResolver: createOpenAIRouteModelResolver({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
    };

    const before = await prepareSimpleCompletionModel({ ...params, preparedModelRuntime });
    credential = { ...credential, access: "access-after-refresh", refresh: "refresh-after" };
    const after = await prepareSimpleCompletionModel({ ...params, preparedModelRuntime });

    expectPreparedModelResult(before);
    expectPreparedModelResult(after);
    expect(before.auth.apiKey).toBe("access-before-refresh");
    expect(after.auth.apiKey).toBe("access-after-refresh");
    expect(before.sourceAuthFingerprint).toBe(after.sourceAuthFingerprint);
    expect(after.sourceAuthFingerprint).toBe(
      fingerprintAuthProfileCredential({ profileId, credential }),
    );
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      error: "Unknown model: anthropic/missing-model",
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "anthropic",
      modelId: "missing-model",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "models.providers.anthropic",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error:
        'No API key resolved for provider "anthropic" (auth mode: api-key, checked: models.providers.anthropic).',
      auth: {
        source: "models.providers.anthropic",
        mode: "api-key",
      },
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-sonnet-4-6",
      allowMissingApiKeyModes: ["aws-sdk"],
    });

    expectPreparedModelResult(result);
    expect(result.model.provider).toBe("amazon-bedrock");
    expect(result.model.id).toBe("anthropic.claude-sonnet-4-6");
    expect(result.auth).toEqual({
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: {
        apiKey: "ghu_test",
        authMode: "token",
        modelId: "gpt-4.1",
      },
    });
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("github-copilot");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("copilot-runtime-token");
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // Callers must only receive the short-lived Copilot runtime token. The
    // original GitHub token is broader auth material and must not leave prep.
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("keeps an exchanged Copilot token opaque when its source is a sentinel", async () => {
    const sourceSecret = "github-source-secret";
    const sourceSentinel = mintSecretSentinel(sourceSecret, {
      label: "model-auth:github-copilot",
    });
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: { provider: "github-copilot", id: "gpt-4.1", api: "openai-completions" },
      authStorage: { setRuntimeApiKey: hoisted.setRuntimeApiKeyMock },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: sourceSentinel,
      source: "profile:github-copilot:default",
      mode: "token",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(callArg(hoisted.prepareProviderRuntimeAuthMock)).toMatchObject({
      provider: "github-copilot",
      context: { apiKey: sourceSentinel },
    });
    expectPreparedModelResult(result);
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("copilot-runtime-token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-4.1",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      source: "profile:github-copilot:default",
      mode: "token",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.copilot.enterprise.example",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "github-copilot",
      modelId: "gpt-4.1",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model.baseUrl).toBe("https://api.copilot.enterprise.example");
  });

  it("returns error when getApiKeyForModelCore throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "local-openai",
        id: "chat-local",
        api: "openai-completions",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      source: "models.providers.local-openai (synthetic local key)",
      mode: "api-key",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      provider: "local-openai",
      id: "chat-local",
      api: "openai-completions",
      headers: { Authorization: null },
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "local-openai",
      modelId: "chat-local",
    });

    const overrideCall = hoisted.applyLocalNoAuthHeaderOverrideMock.mock.calls.at(0);
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.provider).toBe(
      "local-openai",
    );
    expect((overrideCall?.[0] as { provider?: string; id?: string } | undefined)?.id).toBe(
      "chat-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.apiKey).toBe(
      "custom-local",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.source).toBe(
      "models.providers.local-openai (synthetic local key)",
    );
    expect((overrideCall?.[1] as { apiKey?: string; source?: string; mode?: string })?.mode).toBe(
      "api-key",
    );
    expectPreparedModelResult(result);
    expect(result.model.headers?.Authorization).toBeNull();
  });

  it("applies provider runtime auth before storing simple-completion credentials", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      model: {
        provider: "amazon-bedrock-mantle",
        id: "anthropic.claude-opus-4-7",
        api: "anthropic-messages",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.ensureAuthProfileStoreMock.mockReturnValueOnce({
      version: 1,
      profiles: {
        mantle: {
          type: "api_key",
          provider: "amazon-bedrock-mantle",
          key: "__amazon_bedrock_mantle_iam__",
        },
      },
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "__amazon_bedrock_mantle_iam__",
      source: "models.providers.amazon-bedrock-mantle.apiKey",
      mode: "api-key",
      profileId: "mantle",
    });
    hoisted.prepareProviderRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "bedrock-runtime-token",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "amazon-bedrock-mantle",
      modelId: "anthropic.claude-opus-4-7",
      agentDir: "/tmp/openclaw-agent",
    });

    const runtimeAuthInput = callArg(hoisted.prepareProviderRuntimeAuthMock) as {
      provider?: string;
      workspaceDir?: string;
      context?: {
        apiKey?: string;
        authMode?: string;
        modelId?: string;
        profileId?: string;
      };
    };
    expect(runtimeAuthInput.provider).toBe("amazon-bedrock-mantle");
    expect(runtimeAuthInput.workspaceDir).toBe("/tmp/runtime-workspace");
    expect(runtimeAuthInput.context?.apiKey).toBe("__amazon_bedrock_mantle_iam__");
    expect(runtimeAuthInput.context?.authMode).toBe("api-key");
    expect(runtimeAuthInput.context?.modelId).toBe("anthropic.claude-opus-4-7");
    expect(runtimeAuthInput.context?.profileId).toBe("mantle");
    const [storedProvider, storedKey] = hoisted.setRuntimeApiKeyMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(storedProvider).toBe("amazon-bedrock-mantle");
    expect(looksLikeSecretSentinel(storedKey)).toBe(true);
    expect(storedKey).not.toBe("bedrock-runtime-token");
    expect(resolveSecretSentinel(storedKey)).toBe("bedrock-runtime-token");
    expectPreparedModelResult(result);
    expect(result.model.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic");
    expect(looksLikeSecretSentinel(result.auth.apiKey ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.auth.apiKey ?? "")).toBe("bedrock-runtime-token");
  });

  it("can skip agent model/auth discovery for config-scoped one-shot completions", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "ollama",
        id: "llama3.2:latest",
        api: "ollama",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "ollama",
      modelId: "llama3.2:latest",
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "ollama",
      "llama3.2:latest",
      "/tmp/openclaw-agent",
      completionConfig,
      expect.objectContaining({
        skipAgentDiscovery: true,
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });

  it("uses asynchronous provider model discovery", async () => {
    // Use a standalone mock so the default beforeEach delegation from
    // resolveModelAsyncMock → resolveModelMock does not pollute call
    // history. Only the async resolver should be invoked.
    const resolveModelAsync = vi.fn().mockResolvedValue({
      model: {
        provider: "anthropic",
        id: "claude-opus-4-6",
        api: "anthropic-messages",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });
    // Reset the hoisted sync mock so any leftover calls from earlier tests
    // or beforeEach setup don't cause a false positive.
    hoisted.resolveModelMock.mockReset();

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelResolver: resolveModelAsync,
    });

    expectPreparedModelResult(result);
    expect(hoisted.resolveModelMock).not.toHaveBeenCalled();
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "anthropic",
      "claude-opus-4-6",
      "/tmp/openclaw-agent",
      completionConfig,
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });

  it("passes static catalog fallback opt-in to skip-discovery model resolution", async () => {
    hoisted.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: "mistral",
        id: "mistral-medium-3-5",
        api: "mistral-conversations",
      },
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: completionConfig,
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      modelResolver: hoisted.resolveModelAsyncMock,
    });

    expect(result).not.toHaveProperty("error");
    expect(hoisted.resolveModelAsyncMock).toHaveBeenCalledWith(
      "mistral",
      "mistral-medium-3-5",
      "/tmp/openclaw-agent",
      completionConfig,
      expect.objectContaining({
        allowBundledStaticCatalogFallback: true,
        skipAgentDiscovery: true,
        workspaceDir: "/tmp/runtime-workspace",
        preparedModelRuntime: expect.anything(),
      }),
    );
  });
});
