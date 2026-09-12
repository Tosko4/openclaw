import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigWriteApplicationStatus } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshModelAuthStateAfterMutation } from "../gateway/model-auth-refresh.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  refreshProviderLoginAuthState,
  runProviderChannelLoginFlow,
  type ProviderChannelLoginChoice,
} from "./provider-auth-login-flow-runtime.js";

const prepareModelRuntimeSnapshot = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles/path-resolve.js", () => ({
  reloadSharedAuthStoreOwnership: vi.fn(),
}));
vi.mock("../agents/auth-profiles/runtime-snapshots.js", () => ({
  noteRuntimeAuthProfileStorePersistedMutation: vi.fn(),
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot,
  withDeferredPreparedModelCatalogRefresh: async <T>(
    _agentDir: string,
    operation: () => Promise<T>,
  ) => await operation(),
}));
vi.mock("../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => true),
}));
vi.mock("../gateway/server-methods/models-auth-status-usage-cache.js", () => ({
  clearModelAuthStatusUsageCache: vi.fn(),
}));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: (config: OpenClawConfig) => Object.keys(config.agents?.entries ?? {}),
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    config.agents!.entries![agentId]!.agentDir,
}));

const choice: ProviderChannelLoginChoice = {
  choiceId: "device",
  pluginId: "fixture",
  providerId: "fixture",
  methodId: "device-code",
  label: "Fixture device login",
  providerLabel: "Fixture",
  command: "fixture/device",
  mode: "chat",
};
vi.mock("../plugins/provider-login-options.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-login-options.js")>()),
  resolveProviderChannelLoginChoice: () => ({ status: "resolved", choice }),
}));

function createRefreshOwner() {
  let config: OpenClawConfig = {
    agents: { entries: { main: { agentDir: "/tmp/login-original/main/agent" } } },
  };
  const entered = createDeferredCore();
  const application = createDeferredCore<RuntimeConfigWriteApplicationStatus>();
  const readConfig = () => config;
  const refreshAuthState = (agentId: string) =>
    refreshModelAuthStateAfterMutation(
      {
        getRuntimeConfig: readConfig,
        reconcileConfigAfterExternalWrite: () => {
          entered.resolve();
          return application.promise;
        },
      },
      "login",
      agentId,
    );
  return {
    readConfig,
    refreshAuthState,
    entered,
    application,
    reassign() {
      config = { agents: { entries: { main: { agentDir: "/tmp/login-replaced/main/agent" } } } };
    },
  };
}

describe("provider channel login host refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the SDK login result pending until the host applies its saved configuration", async () => {
    const owner = createRefreshOwner();
    const login = runProviderChannelLoginFlow({
      choice,
      agentId: "main",
      config: owner.readConfig(),
      readConfig: owner.readConfig,
      refreshAuthState: owner.refreshAuthState,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      sendMessage: vi.fn(async () => {}),
      unsupportedPromptMessage: "Use the setup screen.",
      runLoginFlow: async (opts) => {
        await expectDefined(opts.refreshAfterLogin, "SDK login refresh operation")("main");
        return {
          providerId: "fixture",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [{ profileId: "fixture:saved", provider: "fixture", mode: "oauth" }],
        };
      },
    });
    try {
      expect(
        await Promise.race([
          owner.entered.promise.then(() => "applying"),
          login.then(() => "completed"),
        ]),
      ).toBe("applying");
      expect(prepareModelRuntimeSnapshot).not.toHaveBeenCalled();
      owner.application.resolve("applied");
      await expect(login).resolves.toMatchObject({ authRefresh: "refreshed" });
      expect(prepareModelRuntimeSnapshot).toHaveBeenCalledWith({
        config: owner.readConfig(),
        agentId: "main",
        agentDir: "/tmp/login-original/main/agent",
      });
    } finally {
      owner.application.resolve("applied");
      await login;
    }
  });

  it("rejects a reassigned agent after the SDK refresh has awaited host application", async () => {
    const owner = createRefreshOwner();
    const refresh = refreshProviderLoginAuthState({
      agentId: "main",
      readConfig: owner.readConfig,
      assertCurrent: vi.fn(),
      refreshAuthState: owner.refreshAuthState,
    });
    const outcome = refresh.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      expect(
        await Promise.race([
          owner.entered.promise.then(() => "applying"),
          outcome.then(({ status }) => status),
        ]),
      ).toBe("applying");
      owner.reassign();
      owner.application.resolve("applied");
      expect(await outcome).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({
          message: expect.stringContaining("Agent authentication scope changed"),
        }),
      });
      expect(prepareModelRuntimeSnapshot).not.toHaveBeenCalled();
    } finally {
      owner.application.resolve("applied");
      await outcome;
    }
  });
  it("does not report refreshed when caller authority retires during host application", async () => {
    const owner = createRefreshOwner();
    let current = true;
    const refresh = refreshProviderLoginAuthState({
      agentId: "main",
      readConfig: owner.readConfig,
      refreshAuthState: owner.refreshAuthState,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Login caller authority retired.");
        }
      },
    });
    const outcome = refresh.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      expect(
        await Promise.race([
          owner.entered.promise.then(() => "applying"),
          outcome.then(({ status }) => status),
        ]),
      ).toBe("applying");
      current = false;
      owner.application.resolve("applied");
      expect(await outcome).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ message: "Login caller authority retired." }),
      });
    } finally {
      owner.application.resolve("applied");
      await outcome;
    }
  });
});
