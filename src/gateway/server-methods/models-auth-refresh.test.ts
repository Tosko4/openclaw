import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RuntimeConfigWriteApplicationStatus } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  reloadSharedAuthStoreOwnership: vi.fn(),
  clearModelAuthStatusUsageCache: vi.fn(),
  noteRuntimeAuthProfileStorePersistedMutation: vi.fn(),
  refreshActiveProviderAuthRuntimeSnapshot: vi.fn(async () => true),
  prepareModelRuntimeSnapshot: vi.fn(async (_input: unknown) => {}),
}));

vi.mock("../../agents/auth-profiles/path-resolve.js", () => ({
  reloadSharedAuthStoreOwnership: mocks.reloadSharedAuthStoreOwnership,
}));
vi.mock("../../agents/auth-profiles/runtime-snapshots.js", () => ({
  noteRuntimeAuthProfileStorePersistedMutation: mocks.noteRuntimeAuthProfileStorePersistedMutation,
}));
vi.mock("../../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: mocks.prepareModelRuntimeSnapshot,
}));
vi.mock("../../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshActiveProviderAuthRuntimeSnapshot,
}));
vi.mock("./models-auth-status-usage-cache.js", () => ({
  clearModelAuthStatusUsageCache: mocks.clearModelAuthStatusUsageCache,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: (config: OpenClawConfig) => config.agents?.list?.map((agent) => agent.id) ?? [],
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    config.agents?.list?.find((agent) => agent.id === agentId)?.agentDir,
}));

import { modelsAuthRefreshHandlers } from "./models-auth-refresh.js";

const handler = expectDefined(
  modelsAuthRefreshHandlers["models.authRefresh"],
  "registered models.authRefresh handler",
);

function requestAuthRefresh(
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "reconcileConfigAfterExternalWrite">,
) {
  const params = { agentId: "main", operation: "login" };
  const respond = vi.fn<RespondFn>();
  const completion = handler({
    req: { type: "req", id: "auth-refresh-test", method: "models.authRefresh", params },
    params,
    respond,
    context: createDirectChatContext(context),
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond, completion };
}

const initialConfig: OpenClawConfig = {
  agents: { list: [{ id: "main", agentDir: "/tmp/original-agent" }] },
};

describe("model auth external-write reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains the working source before config application and acknowledges its final owner", async () => {
    const application = createDeferred<RuntimeConfigWriteApplicationStatus>();
    let config = initialConfig;
    const context = {
      getRuntimeConfig: () => config,
      reconcileConfigAfterExternalWrite: vi.fn(() => application.promise),
    };
    const refresh = requestAuthRefresh(context);
    expect(mocks.noteRuntimeAuthProfileStorePersistedMutation).toHaveBeenCalledWith(
      "/tmp/original-agent",
      expect.objectContaining({ credentialsChanged: true, profileSetChanged: true }),
    );
    expect(context.reconcileConfigAfterExternalWrite).toHaveBeenCalledOnce();
    expect(
      mocks.noteRuntimeAuthProfileStorePersistedMutation.mock.invocationCallOrder[0],
    ).toBeLessThan(context.reconcileConfigAfterExternalWrite.mock.invocationCallOrder[0]!);
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareModelRuntimeSnapshot).not.toHaveBeenCalled();
    expect(refresh.respond).not.toHaveBeenCalled();
    config = {
      ...initialConfig,
      auth: { profiles: { saved: { provider: "fixture", mode: "token" } } },
    };
    application.resolve("applied");
    await refresh.completion;
    expect(refresh.respond).toHaveBeenCalledWith(true, { refreshed: true }, undefined);
    expect(mocks.prepareModelRuntimeSnapshot).toHaveBeenCalledWith({
      config,
      agentId: "main",
      agentDir: "/tmp/original-agent",
    });
  });

  it.each<RuntimeConfigWriteApplicationStatus>([
    "failed",
    "stopped",
    "superseded",
    "restart-pending",
    "applied-restart-required",
    "unclaimed",
  ])("does not acknowledge a %s config application", async (status) => {
    const refresh = requestAuthRefresh({
      getRuntimeConfig: () => initialConfig,
      reconcileConfigAfterExternalWrite: async () => status,
    });
    await refresh.completion;
    expect(refresh.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining(`configuration application is ${status}`),
      }),
    );
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareModelRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("does not redirect the saved account to a reassigned agent directory", async () => {
    let config = initialConfig;
    const refresh = requestAuthRefresh({
      getRuntimeConfig: () => config,
      reconcileConfigAfterExternalWrite: async () => {
        config = { agents: { list: [{ id: "main", agentDir: "/tmp/reassigned-agent" }] } };
        return "applied";
      },
    });
    await refresh.completion;
    expect(refresh.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Agent authentication scope changed"),
      }),
    );
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareModelRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("rechecks the original store after prepared-owner publication", async () => {
    let config = initialConfig;
    mocks.prepareModelRuntimeSnapshot.mockImplementationOnce(async () => {
      config = { agents: { list: [{ id: "main", agentDir: "/tmp/reassigned-agent" }] } };
    });
    const refresh = requestAuthRefresh({
      getRuntimeConfig: () => config,
      reconcileConfigAfterExternalWrite: async () => "applied",
    });
    await refresh.completion;
    expect(refresh.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("Agent authentication scope changed"),
      }),
    );
  });
});
