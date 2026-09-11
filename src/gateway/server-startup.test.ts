/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import type { OpenClawConfig } from "../config/config.js";
import { createAbortError } from "../infra/abort-signal.js";

const catalogOwnerIsCurrent = vi.fn(() => true);
const loadPreparedModelCatalogSnapshotMock = vi.fn(async (_params: unknown) => ({
  entries: [],
  routeVariants: [],
}));
vi.mock("../agents/prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => ({ isCurrent: catalogOwnerIsCurrent }),
  loadPreparedModelCatalogSnapshot: (params: unknown) =>
    loadPreparedModelCatalogSnapshotMock(params),
}));

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn(
  async (
    _cfg: OpenClawConfig,
    _options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
    },
  ) => {},
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
  listAgentIds: () => ["default"],
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: (
    cfg: OpenClawConfig,
    options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
    },
  ) => refreshPreparedModelRuntimeSnapshotsMock(cfg, options),
}));

let prewarmConfiguredPrimaryModel: typeof import("./server-startup-post-attach.js").testing.prewarmConfiguredPrimaryModel;
let hydrateConfiguredExternalCliAuth: typeof import("./server-startup-post-attach.js").testing.hydrateConfiguredExternalCliAuth;
let publishStartupModelRuntime: typeof import("./server-startup-post-attach.js").testing.publishStartupModelRuntime;
let shouldSkipStartupModelPrewarm: typeof import("./server-startup-post-attach.js").testing.shouldSkipStartupModelPrewarm;

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      testing: {
        prewarmConfiguredPrimaryModel,
        hydrateConfiguredExternalCliAuth,
        publishStartupModelRuntime,
        shouldSkipStartupModelPrewarm,
      },
    } = await import("./server-startup-post-attach.js"));
  });

  beforeEach(() => {
    catalogOwnerIsCurrent.mockReturnValue(true);
    loadPreparedModelCatalogSnapshotMock.mockClear();
    prepareModelRuntimeSnapshotMock.mockClear();
    refreshPreparedModelRuntimeSnapshotsMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("publishes the full startup catalog through the refresh owner", async () => {
    const cfg = {};
    await prewarmConfiguredPrimaryModel({ cfg, log: { warn: vi.fn() } });
    expect(loadPreparedModelCatalogSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      agentId: "default",
      readOnly: false,
      refreshFullCatalog: true,
    });
  });

  it.each([
    ["abort", createAbortError("cancelled")],
    ["superseded", new PreparedModelRuntimePublicationSupersededError("superseded")],
    ["config replaced", new PreparedModelCatalogConfigReplacedError("/tmp/agent")],
    ["retired owner", new Error("lifetime closed")],
  ])("propagates catalog lifecycle failure: %s", async (kind, error) => {
    if (kind === "retired owner") {
      catalogOwnerIsCurrent.mockReturnValue(false);
    }
    loadPreparedModelCatalogSnapshotMock.mockRejectedValueOnce(error);
    const warn = vi.fn();
    await expect(prewarmConfiguredPrimaryModel({ cfg: {}, log: { warn } })).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
  });

  it("hydrates configured external CLI auth before prepared owner publication", async () => {
    const cfg = {} as OpenClawConfig;
    const hydrate = vi.fn();

    await hydrateConfiguredExternalCliAuth({
      getConfig: () => cfg,
      log: { warn: vi.fn() },
      deps: {
        listAgentIds: () => ["main", "secondary"],
        resolveAgentDir: (_config, agentId) => `/tmp/${agentId}`,
        collectConfiguredRefs: (_config, agentId) => [
          { value: agentId === "main" ? "openai/gpt-5.4" : "anthropic/sonnet-4.6" },
        ],
        hydrate,
      },
    });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/main", ["openai"]);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/secondary", ["anthropic"]);
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("prewarms the default catalog when no explicit primary model is configured", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("honors the startup model prewarm skip env", () => {
    expect(shouldSkipStartupModelPrewarm({})).toBe(false);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "true",
      }),
    ).toBe(true);
  });

  it("publishes required runtime snapshots when optional startup prewarm is skipped", async () => {
    vi.stubEnv("OPENCLAW_SKIP_STARTUP_MODEL_PREWARM", "1");
    const optionalPrewarm = vi.fn(async () => {});
    try {
      await publishStartupModelRuntime(
        {
          cfg: {} as OpenClawConfig,
          workspaceDir: "/tmp/skip-explicit-workspace",
          log: { warn: vi.fn() },
        },
        optionalPrewarm,
      );

      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce();
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          allowGatewaySubagentBinding: true,
          defaultWorkspaceDir: "/tmp/skip-explicit-workspace",
        }),
      );
      expect(optionalPrewarm).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("publishes lifecycle owners for configured CLI backends", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "codex-cli/gpt-5.5",
          },
        },
      },
    } as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({ cfg, log: { warn: vi.fn() } });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("preserves the explicit startup workspace in the published default owner", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      workspaceDir: "/tmp/explicit-workspace",
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: "/tmp/explicit-workspace",
    });
  });

  it("propagates lifecycle catalog preparation failure", async () => {
    const error = new Error("models write failed");
    refreshPreparedModelRuntimeSnapshotsMock.mockRejectedValueOnce(error);

    await expect(
      prewarmConfiguredPrimaryModel({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex/gpt-5.4",
              },
            },
          },
        } as OpenClawConfig,
        log: { warn: vi.fn() },
      }),
    ).rejects.toBe(error);
  });
});
