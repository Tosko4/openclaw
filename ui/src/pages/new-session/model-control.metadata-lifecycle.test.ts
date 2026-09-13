import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogResult, SessionsListResult } from "../../api/types.ts";
import {
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

function retainedAccountDraft() {
  const model: ModelCatalogEntry = {
    id: "model",
    name: "Model",
    provider: "anthropic",
    available: false,
    unavailableReason: "missing-auth",
  };
  const account = {
    authProfileId: "personal:person-a:anthropic:one",
    provider: "anthropic",
    label: "Saved account A1",
    authType: "token",
    selected: false,
  };
  const { context, request } = contextWith([model]);
  Object.assign(context.sessions.state.result!.defaults, {
    model: "model",
    modelProvider: "anthropic",
  });
  Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
  const preview = deferred<ModelCatalogResult>();
  const neutral: ModelCatalogResult = {
    models: [model],
    accountSelection: { kind: "automatic", label: "Automatic" },
  };
  const connected: ModelCatalogResult = {
    models: [{ ...model, available: true, unavailableReason: undefined }],
    accountSelection: {
      kind: "personal",
      authProfileId: account.authProfileId,
      label: account.label,
    },
  };
  request.mockImplementation((method: string, params: { authProfileId?: string }) => {
    if (method === "users.listModelAccounts") {
      return Promise.resolve({ profileId: "person-a", accounts: [account], links: [] });
    }
    return params.authProfileId ? preview.promise : Promise.resolve(neutral);
  });
  const savePreference = vi.fn();
  const control = new NewSessionModelControl(() => undefined, savePreference);
  control.load(context, "main", true);
  const draw = (id = "main") => renderControl(control, context, id);
  const select = (value: string) =>
    draw().querySelector<HTMLButtonElement>(`[data-chat-account-option="${value}"]`)!.click();
  const chooseAccount = async () => {
    await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("missing-auth"));
    const picker = draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]");
    expect(picker).not.toBeNull();
    picker!.click();
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    select(`account:${account.authProfileId}`);
    return {
      completion: vi.waitFor(() =>
        expect(control.modelSelectionBlockedReason()).not.toBe("Loading models…"),
      ),
    };
  };
  return {
    account,
    context,
    control,
    request,
    preview,
    connected,
    neutral,
    draw,
    select,
    chooseAccount,
    savePreference,
  };
}

describe("new-session model metadata lifecycle", () => {
  it("retries failed session defaults on picker open without rereading healthy defaults", async () => {
    const retry = deferred<SessionsListResult>();
    const readDefaults = vi
      .fn<() => Promise<SessionsListResult>>()
      .mockRejectedValueOnce(new Error("Session defaults unavailable"))
      .mockReturnValue(retry.promise);
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return readDefaults();
      }
      return { models: [{ id: "recovered", name: "Recovered", provider: "example" }] };
    });
    const { gateway } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    const { context } = contextWith([]);
    Object.assign(context, { gateway, sessions });
    const control = new NewSessionModelControl(() => undefined);
    const draw = () => renderControl(control, context);
    const openPicker = () =>
      draw().querySelector<HTMLElement>('[data-chat-model-select="true"]')!.click();
    try {
      control.load(context, "main", true);
      await vi.waitFor(() =>
        expect(draw().querySelector('[data-chat-model-catalog-state="error"]')).not.toBeNull(),
      );
      expect(draw().querySelector('[data-chat-model-option="example/recovered"]')).not.toBeNull();
      expect(readDefaults).toHaveBeenCalledOnce();
      openPicker();
      await vi.waitFor(() => expect(readDefaults).toHaveBeenCalledTimes(2));
      const result = sessionsResult([], 1);
      result.defaults = { model: "recovered", modelProvider: "example", contextTokens: null };
      retry.resolve(result);
      await vi.waitFor(() => {
        expect(draw().querySelector("[data-chat-model-catalog-state]")).toBeNull();
        expect(draw().querySelector('[data-chat-model-select="true"]')?.textContent).toContain(
          "Recovered",
        );
      });
      const reads = request.mock.calls.length;
      openPicker();
      expect(readDefaults).toHaveBeenCalledTimes(2);
      expect(request.mock.calls).toHaveLength(reads);
    } finally {
      control.reset();
      sessions.dispose();
    }
  });

  it("enables a cooled-down model on reopen without a catalog event", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "example",
      available: false,
      unavailableReason: "cooldown",
      unavailableUntil: 12_000,
    };
    const { context, request } = contextWith([model]);
    Object.assign(context.sessions.state.result!.defaults, {
      model: "model",
      modelProvider: "example",
    });
    const control = new NewSessionModelControl(() => undefined);
    const option = () =>
      renderControl(control, context, "main").querySelector<HTMLButtonElement>(
        '[data-chat-model-option="example/model"]',
      );
    try {
      control.load(context, "main", true);
      await vi.waitFor(() => expect(option()?.disabled).toBe(true));
      request.mockResolvedValueOnce({
        models: [
          { ...model, available: true, unavailableReason: undefined, unavailableUntil: undefined },
        ],
      });
      clock.mockReturnValue(12_000);
      renderControl(control, context, "main")
        .querySelector<HTMLElement>('[data-chat-model-select="true"]')!
        .click();
      await vi.waitFor(() => expect(option()?.disabled).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      control.reset();
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "selects a usable retained account with refresh failure %s without changing saved preferences",
    async (refreshFailed) => {
      const {
        account,
        control,
        request,
        preview,
        connected,
        draw,
        select,
        chooseAccount,
        savePreference,
      } = retainedAccountDraft();
      const { completion } = await chooseAccount();
      expect(request).toHaveBeenLastCalledWith(
        "models.list",
        { view: "configured", agentId: "main", authProfileId: account.authProfileId },
        { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
      );
      expect(control.modelSelectionBlockedReason()).toBe("Loading models…");
      preview.resolve({ ...connected, refreshFailed });
      await completion;
      expect(control.modelSelectionBlockedReason()).toBeUndefined();
      expect(control.accountSelectionReady()).toBe(true);
      expect(draw().querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
        account.label,
      );
      expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
      expect(control.selected).toBe("");
      select("automatic");
      await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("missing-auth"));
      expect(control.modelForSubmission()).toBe("");
      expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
        "Automatic",
      );
      expect(savePreference).not.toHaveBeenCalled();
      expect(
        request.mock.calls.some(([method]) =>
          /users\.(selectModelAccount|prefs\.set)/.test(method),
        ),
      ).toBe(false);
      control.reset();
    },
  );

  it("retries the same draft account after failed previews and accepts its successful result", async () => {
    const { account, control, request, preview, connected, draw, select, chooseAccount } =
      retainedAccountDraft();
    const { completion } = await chooseAccount();
    preview.reject(new Error("Preview unavailable"));
    await completion;
    expect(control.modelSelectionBlockedReason()).toBe("Models unavailable");
    expect(control.accountSelectionReady()).toBe(false);

    draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    const failedRetry = deferred<ModelCatalogResult>();
    request.mockReturnValueOnce(failedRetry.promise);
    select(`account:${account.authProfileId}`);
    expect(control.modelSelectionBlockedReason()).toBe("Loading models…");
    failedRetry.reject(new Error("Preview still unavailable"));
    await vi.waitFor(() =>
      expect(control.modelSelectionBlockedReason()).toBe("Models unavailable"),
    );
    expect(control.accountSelectionReady()).toBe(false);

    draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
    await vi.waitFor(() => expect(draw().textContent).toContain(account.label));
    request.mockResolvedValueOnce(connected);
    select(`account:${account.authProfileId}`);
    await vi.waitFor(() => expect(control.accountSelectionReady()).toBe(true));
    expect(control.modelSelectionBlockedReason()).toBeUndefined();
    expect(draw().querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      account.label,
    );
    expect(control.modelForSubmission()).toBe(`anthropic/model@${account.authProfileId}`);
    control.reset();
  });

  it.each(["missing model", "unconfirmed account", "unknown availability"])(
    "keeps an explicit account blocked after a preview with $0",
    async (outcome) => {
      const { control, preview, connected, chooseAccount } = retainedAccountDraft();
      const { completion } = await chooseAccount();
      expect(control.modelSelectionBlockedReason()).toBe("Loading models…");
      preview.resolve({
        ...connected,
        ...(outcome === "missing model" ? { models: [] } : {}),
        ...(outcome === "unconfirmed account" ? { accountSelection: undefined } : {}),
        ...(outcome === "unknown availability"
          ? {
              models: connected.models?.map((model) =>
                Object.assign({}, model, { available: undefined }),
              ),
            }
          : {}),
      });
      await completion;
      expect(control.modelSelectionBlockedReason()).toBe("Models unavailable");
      control.reset();
    },
  );

  it.each(["identity", "client", "agent", "Automatic", "reset"])(
    "retires the pending account preview after changing $0",
    async (change) => {
      const { context, control, preview, connected, neutral, chooseAccount, select, draw } =
        retainedAccountDraft();
      const { completion } = await chooseAccount();
      let agentId = "main";
      if (change === "identity") {
        Object.assign(context.gateway.snapshot, { selfUser: { id: "person-b", name: "Person B" } });
      } else if (change === "client") {
        Object.assign(context.gateway.snapshot, {
          client: createTestGatewayClient(async () => neutral),
        });
      } else if (change === "agent") {
        agentId = "research";
      } else if (change === "Automatic") {
        select("automatic");
      } else {
        control.reset();
      }
      control.load(context, agentId, true);
      preview.resolve(connected);
      await completion;
      await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("missing-auth"));
      expect(control.modelForSubmission()).toBe("");
      expect(
        draw(agentId).querySelector("[data-chat-account-group-toggle]")?.textContent,
      ).toContain("Automatic");
      control.reset();
    },
  );

  it("retains draft model controls across client replacement but clears them for another agent", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "openai",
      available: true,
    };
    const first = contextWith([model]);
    Object.assign(first.context.sessions.state.result!.defaults, {
      model: "model",
      modelProvider: "openai",
    });
    const control = new NewSessionModelControl(() => undefined);
    control.load(first.context, "main", true);
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledOnce());
    const selection = {
      selected: "openai/model",
      contextWindow: "200k",
      thinkingLevel: "high",
      fastMode: true,
    } as const;
    Object.assign(control, selection);
    const replacement = contextWith([
      { ...model, available: false, unavailableReason: "missing-auth" },
    ]);

    control.load(replacement.context, "main", true);
    expect(control).toMatchObject(selection);
    await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("missing-auth"));
    expect(control).toMatchObject(selection);

    control.load(replacement.context, "research", true);
    expect(control).toMatchObject({
      selected: "",
      contextWindow: "",
      thinkingLevel: "",
      fastMode: undefined,
    });
    control.reset();
  });

  it("retains its neutral auth gate through pending, rejected and failed refreshes, isolated from a session projection", async () => {
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "test",
      available: false,
      unavailableReason: "missing-auth",
    };
    const { context, request, emitCatalogChanged } = contextWith([model]);
    Object.assign(context.sessions.state.result!.defaults, {
      model: "model",
      modelProvider: "test",
    });
    const client = context.gateway.snapshot.client!;
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("missing-auth"));
    const scope = { agentId: "main", sessionKey: "agent:main:locked" };
    const release = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish({
      commands: [],
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    expect(control.modelUnavailableReason()).toBe("missing-auth");
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    request.mockReturnValueOnce(pending.promise);
    emitCatalogChanged();
    expect(control.modelUnavailableReason()).toBe("missing-auth");
    pending.resolve({ models: [{ ...model, unavailableReason: "auth-failed" }] });
    await vi.waitFor(() => expect(control.modelUnavailableReason()).toBe("auth-failed"));
    request.mockRejectedValueOnce(new Error("transport failed"));
    emitCatalogChanged();
    await vi.waitFor(() => {
      const container = renderControl(control, context, "main");
      expect(
        container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-busy"),
      ).toBe("false");
      expect(container.textContent).toContain("No models available");
    });
    expect(control.modelUnavailableReason()).toBe("auth-failed");
    request.mockResolvedValueOnce({
      models: [{ ...model, available: true, unavailableReason: undefined }],
    });
    emitCatalogChanged();
    await vi.waitFor(() => expect(control.modelUnavailableReason()).toBeUndefined());
    release();
    control.reset();
  });

  it("reuses published models on picker open and refreshes after publication", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "example" }];
    const published = [...prepared, { id: "published", name: "Published", provider: "example" }];
    const { context, request, emitCatalogChanged } = contextWith(prepared);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="example/prepared"]',
        ),
      ).not.toBeNull(),
    );
    request.mockResolvedValue({ models: published });
    const picker = renderControl(control, context).querySelector<HTMLDetailsElement>(
      ".chat-controls__model-picker",
    )!;
    picker.querySelector("summary")!.click();
    expect(request).toHaveBeenCalledTimes(1);
    emitCatalogChanged();
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector(
          '[data-chat-model-option="example/published"]',
        ),
      ).not.toBeNull(),
    );
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["models.list", { view: "configured", agentId: "main" }],
      ["models.list", { view: "configured", agentId: "main" }],
    ]);
    control.reset();
  });

  it("restores cached controls synchronously after teardown", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        available: false,
        unavailableReason: "missing-auth",
      },
    ];
    const { context, request } = contextWith(models);
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(firstControl.modelUnavailableReason()).toBe("missing-auth"));
    firstControl.reset();

    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    expect(remountedControl.modelUnavailableReason()).toBe("missing-auth");
    expect(remountedControl.isRestoringPreference()).toBe(false);

    const container = renderControl(remountedControl, context, "main");
    expect(container.querySelector('[data-chat-model-catalog-state="ready"]')).not.toBeNull();
    expect(remountedControl.modelUnavailableReason()).toBe("missing-auth");
    expect(
      container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("No models available");
    expect(request).toHaveBeenCalledTimes(1);
    remountedControl.reset();
  });

  it("aborts a retired control request and gives the remounted control its own result", async () => {
    const models: ModelCatalogEntry[] = [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
    ];
    const pending = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request } = contextWith([]);
    request.mockImplementationOnce((_method, _params, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener(
        "abort",
        () => pending.reject(new DOMException("metadata request aborted", "AbortError")),
        { once: true },
      );
      return pending.promise;
    });
    const firstControl = new NewSessionModelControl(() => undefined);
    firstControl.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstControl.reset();
    request.mockResolvedValueOnce({ models });
    const remountedControl = new NewSessionModelControl(() => undefined);
    remountedControl.load(context, "main", true);
    pending.resolve({ models });

    await vi.waitFor(() => {
      const container = renderControl(remountedControl, context);
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
      expect(
        container.querySelector('[data-chat-model-option="openai/gpt-5.6-luna"]'),
      ).not.toBeNull();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]?.signal.aborted).toBe(true);
    remountedControl.reset();
  });

  it("reapplies an updated preference against the attached ready snapshot", async () => {
    const models: ModelCatalogEntry[] = [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "high", label: "high" }],
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        reasoning: true,
        thinkingLevels: [{ id: "low", label: "low" }],
      },
    ];
    const refresh = deferred<{ models: ModelCatalogEntry[] }>();
    const { context, request, emitCatalogChanged } = contextWith(models);
    const control = new NewSessionModelControl(() => undefined);

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-sol", thinkingLevel: "high" },
    });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-sol"));
    expect(control.thinkingLevel).toBe("high");
    request.mockReturnValueOnce(refresh.promise);
    emitCatalogChanged();

    control.load(context, "main", true, {
      preference: { model: "openai/gpt-5.6-luna", thinkingLevel: "low" },
    });

    refresh.resolve({ models });
    await vi.waitFor(() => expect(control.selected).toBe("openai/gpt-5.6-luna"));
    expect(control.thinkingLevel).toBe("low");
    expect(request).toHaveBeenCalledTimes(2);
    control.reset();
  });
});
