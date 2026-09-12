import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginResult,
  loginSessionMocks,
  registerLoginCommand,
  resetLoginCommandMocks,
  type TelegramLoginFlow,
} from "./bot-native-command-login.test-support.js";
import { createPrivateCommandContext } from "./bot-native-commands.menu-test-support.js";

describe("registerTelegramNativeCommands /login session profile", () => {
  beforeEach(resetLoginCommandMocks);

  it("moves the target session to the profile returned by Telegram /login codex", async () => {
    const finishLogin = createDeferred<void>();
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:new-owner@example.com");
    });

    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
    finishLogin.resolve();

    expect(runModelsAuthLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
      }),
    );
    expect(
      (runModelsAuthLoginFlow.mock.calls[0]?.[0] as { profileId?: string } | undefined)?.profileId,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(loginSessionMocks.patchSessionEntry).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
        requireWriteSuccess: true,
        skipMaintenance: true,
        assertCommitAllowed: expect.any(Function),
        update: expect.any(Function),
      }),
    );
    const patchUpdate = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update?.({
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-main",
      updatedAt: 1,
    });
    expect(patchUpdate).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("moves a session created while Telegram login is pending to the returned profile", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "NEW-SESSION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:new-owner@example.com");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() => expect(loginSessionMocks.patchSessionEntry).toHaveBeenCalledTimes(1));
    const update = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: SessionEntry) => Partial<SessionEntry> | null;
      }
    )?.update;
    expect(
      update?.({
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      }),
    ).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("preserves a later user-selected profile on a session created during Telegram login", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "LATER-USER-SELECTION",
      });
      await finishLogin.promise;
      return createLoginResult("openai:login-profile");
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        authProfileOverride: "openai:later-user-profile",
        authProfileOverrideSource: "user",
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
        {},
      ),
    );
    expect(sessionStore["agent:main:main"]?.authProfileOverride).toBe("openai:later-user-profile");
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("marks a same-profile Telegram login as user-selected", async () => {
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    const update = (
      loginSessionMocks.patchSessionEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update;
    expect(update).toBeTypeOf("function");
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      }),
    ).toEqual({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "user",
        sessionId: "sess-main",
        updatedAt: 2,
      }),
    ).toBeNull();
  });

  it.each([
    {
      authRefresh: "refreshed",
      message:
        'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.',
    },
    {
      authRefresh: "gateway-rejected",
      message:
        'OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.',
    },
    {
      authRefresh: "gateway-unreachable",
      message:
        'OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.',
    },
  ] as const)(
    "preserves $authRefresh when Telegram cannot persist the returned session profile",
    async ({ authRefresh, message }) => {
      loginSessionMocks.loadSessionStore.mockReturnValue({
        "agent:main:main": {
          authProfileOverride: "openai:old-owner@example.com",
          modelOverride: "test-model",
          sessionId: "sess-main",
          updatedAt: 1,
        },
      });
      loginSessionMocks.patchSessionEntry.mockRejectedValueOnce(new Error("write failed"));
      const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
        createLoginResult("openai:new-owner@example.com", authRefresh),
      );
      const { handler, sendMessage } = registerLoginCommand({
        accountId: "default",
        cfg: {
          commands: { native: true, ownerAllowFrom: ["200"] },
        } as OpenClawConfig,
        allowFrom: ["200"],
        loginFlow: runModelsAuthLoginFlow,
      });

      await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

      expect(sendMessage).toHaveBeenCalledWith(100, message, {});
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("kept its previous account"),
        {},
      );
      expect(sendMessage).not.toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        expect.any(Object),
      );
    },
  );

  it("reports partial success when Telegram login returns no OpenAI profile", async () => {
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("revalidates an unchanged Telegram profile after device login", async () => {
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      sessionId: "sess-main",
      updatedAt: 1,
    };
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": previousEntry,
    });
    loginSessionMocks.patchSessionEntry.mockImplementationOnce(async (params) => {
      const concurrentEntry = {
        ...previousEntry,
        authProfileOverride: "openai:concurrent-owner@example.com",
        updatedAt: 2,
      };
      const patch = await params.update({ ...concurrentEntry });
      params.assertCommitAllowed?.();
      return patch ? { ...concurrentEntry, ...patch } : concurrentEntry;
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });
});
