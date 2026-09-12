import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ModelsAuthLoginFlowOptions,
  ProviderAuthConfigApplyError,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginResult,
  createOwnerLoginConfig,
  exerciseDeferredModelAccess,
  registerLoginCommand,
  loginGatewayRequest,
  loginSessionMocks,
  resetLoginCommandMocks,
  type TelegramLoginFlow,
} from "./bot-native-command-login.test-support.js";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  deliverReplies,
  createPrivateCommandContext,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

describe("registerTelegramNativeCommands /login", () => {
  beforeEach(resetLoginCommandMocks);

  it("waits for the bound Gateway before replying to native login refresh", async () => {
    const entered = createDeferred<void>();
    const application = createDeferred<{ refreshed: true }>();
    loginGatewayRequest.mockImplementationOnce(async () => {
      entered.resolve();
      return await application.promise;
    });
    const loginFlow = vi.fn();
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });
    const refresh = handler(createPrivateCommandContext({ match: "refresh", userId: 200 }));
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "applying"),
          refresh.then(() => "completed"),
        ]),
      ).toBe("applying");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(loginGatewayRequest).toHaveBeenCalledExactlyOnceWith(
        "models.authRefresh",
        { agentId: "main", operation: "login" },
        { scopes: ["operator.admin"] },
      );
      application.resolve({ refreshed: true });
      await refresh;
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "Sign-in status refreshed. Send /models to see available models.",
        expect.any(Object),
      );
      expect(loginFlow).not.toHaveBeenCalled();
    } finally {
      application.resolve({ refreshed: true });
      await refresh;
    }
  });

  it("delivers the core provider menu and its method continuation without starting login", async () => {
    const loginFlow = vi.fn();
    const { handler, nativeCommandCallbackDispatcher } = registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });
    await handler(createPrivateCommandContext({ match: "", userId: 200 }));
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Choose a provider") })],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
    await nativeCommandCallbackDispatcher?.({
      botUser: telegramBotInfoForTest,
      callbackQuery: {
        id: "provider-selection",
        from: { id: 200, is_bot: false, first_name: "Owner" },
        chat_instance: "private-chat",
        message: {
          message_id: 101,
          date: 1,
          chat: { id: 100, type: "private", first_name: "Owner" },
        },
      },
      commandText: "/login oauth/openai/openai",
    });
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({ text: expect.stringContaining("Choose how to connect") }),
        ],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it("handles /login codex by sending the device code before login completes", async () => {
    let loginParams: ModelsAuthLoginFlowOptions | undefined;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      loginParams = params;
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: [
          "Open this URL in your LOCAL browser and enter the code below.",
          "URL: https://auth.openai.com/codex/device",
        ].join("\n"),
      });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage, setMyCommands } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    expect(setMyCommands).toHaveBeenCalledOnce();
    const registeredCommands = setMyCommands.mock.calls[0]?.[0];
    expect(registeredCommands).toContainEqual({
      command: "login",
      description: "Connect a model provider.",
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginParams).toMatchObject({ provider: "openai", method: "device-code", agent: "main" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 5_000 });

    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts[0]).toContain("URL: https://auth.openai.com/codex/device");
    expect(texts[0]).toContain("Code: <code>ABCD-EFGH</code>");
    expect(texts[0]).toContain("Never share it.");
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(texts.at(-1)).toContain("OpenAI login complete. Try your request again now.");
  });

  it.each([
    {
      authRefresh: "gateway-rejected",
      message:
        "OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again.",
    },
    {
      authRefresh: "gateway-unreachable",
      message:
        "OpenAI credentials are saved. Sign-in status could not be confirmed. Send /login refresh to update it; you do not need to sign in again.",
    },
  ] as const)(
    "reports saved credentials without immediate retry guidance when refresh is $authRefresh",
    async ({ authRefresh, message }) => {
      const loginFlow = vi.fn(async () => createLoginResult("openai:codex", authRefresh));
      const { handler, sendMessage } = registerLoginCommand({
        cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
        loginFlow,
      });

      await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

      expect(sendMessage).toHaveBeenCalledWith(100, message, {});
      expect(sendMessage).not.toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        expect.any(Object),
      );
    },
  );

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    let handlerReturned = false;
    const handlerTask = handler(createPrivateCommandContext({ match: "codex", userId: 200 })).then(
      () => {
        handlerReturned = true;
      },
    );
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Preparing Codex login…",
      ),
    );
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "BUTTON-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });
    if (!nativeCommandCallbackDispatcher) {
      throw new Error("expected login callback dispatcher to be registered");
    }
    const callbackQuery = {
      id: "login-button",
      chat_instance: "login-button-chat",
      data: "tgcmd:/login codex",
      from: { id: 200, is_bot: false, first_name: "Bob", username: "bob" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" as const, first_name: "Owner" },
        reply_markup: {
          inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
        },
      },
    };

    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery,
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it.each(["all", "keep"] as const)(
    "delivers both long-provider controls and completes deferred %s consent through a fresh dispatcher",
    exerciseDeferredModelAccess,
  );

  it("cancels saved-login consent and rejects its old choice", async () => {
    await exerciseDeferredModelAccess("cancel");
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      authRefresh: "refreshed",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
    );
  });

  it("names the active provider when another provider is requested in the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(
      createPrivateCommandContext({ match: "openrouter/openrouter-oauth", userId: 200 }),
    );
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI sign-in is already in progress. Finish it, or send /login cancel to cancel.",
    );
  });

  it("cancels only the owner's private chat after browser-link delivery", async () => {
    const finish = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let settled = 0;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      if (!params.signal) {
        throw new Error("Expected login cancellation signal.");
      }
      signals.push(params.signal);
      try {
        await params.openUrl?.("https://openrouter.ai/auth?code_challenge=fixture");
        await finish.promise;
        params.signal.throwIfAborted();
        return {
          providerId: "openrouter",
          methodId: "oauth",
          authRefresh: "refreshed",
          profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
        };
      } finally {
        settled += 1;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      allowFrom: ["200", "201"],
    });
    const command = (match: string, chatId = 100, userId = 200) =>
      handler(createPrivateCommandContext({ match, chatId, userId }));
    try {
      await command("openrouter/openrouter-oauth");
      await command("openrouter/openrouter-oauth", 101);
      expect(signals).toHaveLength(2);
      await command("cancel", 100, 201);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      await command("cancel");
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(sendMessage).toHaveBeenCalledWith(100, "Provider login cancelled for this chat.", {});
      await command("cancel");
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "No provider login is active in this chat.",
        {},
      );
    } finally {
      await command("cancel");
      await command("cancel", 101);
      finish.resolve();
      await vi.waitFor(() => expect(settled).toBe(signals.length));
    }
    expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("rejects credential persistence after the command owner is removed", async () => {
    const deferred = createDeferred<void>();
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const cfg: OpenClawConfig = {
      commands,
      agents: { list: [{ id: "main", default: true }] },
    };
    let currentConfig = cfg;
    const persist = vi.fn();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-CODE" });
      await deferred.promise;
      opts.assertCurrent?.();
      persist();
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg,
      loginFlow,
      getRuntimeConfig: () => currentConfig,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    currentConfig = { ...cfg, commands: { native: true, ownerAllowFrom: ["999"] } };
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior Telegram pin when the owner is revoked after patch preparation", async () => {
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const previous: SessionEntry = {
      sessionId: "revoked-telegram-owner-session",
      updatedAt: 1,
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    };
    const store = { "agent:main:main": previous };
    loginSessionMocks.loadSessionStore.mockReturnValue(store);
    loginSessionMocks.patchSessionEntry.mockImplementationOnce(
      async (
        write: Parameters<
          typeof import("openclaw/plugin-sdk/session-store-runtime").patchSessionEntry
        >[0],
      ) => {
        const patch = await write.update({ ...previous }, { existingEntry: previous });
        commands.ownerAllowFrom = ["999"];
        write.assertCommitAllowed?.();
        store["agent:main:main"] = patch ? { ...previous, ...patch } : previous;
        return store["agent:main:main"];
      },
    );
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved"));
    const { handler, sendMessage } = registerLoginCommand({ cfg: { commands }, loginFlow });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(store["agent:main:main"]).toBe(previous);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.",
    );
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] ===
          "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    ).toHaveLength(2);
  });

  it("reports saved credentials when provider settings fail after device login", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SAVED-CODE" });
      throw new ProviderAuthConfigApplyError(new Error("provider config write failed"));
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]?.[1]).toContain("Code: <code>SAVED-CODE</code>");
    expect(sendMessage).toHaveBeenLastCalledWith(
      100,
      "OpenAI credentials are saved, but the connection settings could not be applied. Open Models to review the connection settings and try again.",
      {},
    );
    expect(loginSessionMocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      runtime,
    });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
    );
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
        throw new Error("Telegram stopped");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      abortSignal: shutdown.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("keeps pending login alive across a polling-cycle restart", async () => {
    const account = new AbortController();
    const pollingCycle = new AbortController();
    const finishLogin = createDeferred<void>();
    let loginSignal: AbortSignal | undefined;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      loginSignal = params.signal;
      await params.prompter.deviceCode?.({ title: "Codex login", code: "RESTART-CODE" });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { accountId, handler, sendMessage, sendMessageTelegram } = registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
      abortSignal: account.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    pollingCycle.abort(new Error("recoverable polling restart"));
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    expect(loginSignal?.aborted).toBe(false);
    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        "OpenAI login complete. Try your request again now.",
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
