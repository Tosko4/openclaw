import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestConfigFileStore } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRetainedManagedNpmInstallMarkerPath } from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

export const configFiles = createTestConfigFileStore();

export const retentionTempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => {
  const lease = {
    databasePath: "/tmp/openclaw-plugin-index.sqlite",
    signal: new AbortController().signal,
    assertOwned: vi.fn(),
    assertOwnedInTransaction: vi.fn(),
  };
  return {
    lease,
    loadInstalledPluginIndexInstallRecords: vi.fn(),
    replaceConfigFile: vi.fn(),
    restorePersistedInstalledPluginIndexIfCurrent:
      vi.fn<
        typeof import("./installed-plugin-index-store-write.js").restorePersistedInstalledPluginIndexIfCurrent
      >(),
    transformConfigFileWithRetry: vi.fn(),
    withPluginLifecycleLease: vi.fn(
      async (_options: unknown, run: (activeLease: typeof lease) => Promise<unknown>) =>
        await run(lease),
    ),
    writePersistedInstalledPluginIndexInstallRecordsWithLease:
      vi.fn<
        typeof import("./installed-plugin-index-records.js").writePersistedInstalledPluginIndexInstallRecordsWithLease
      >(),
  };
});

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: true, config: {} }),
  replaceConfigFile: mocks.replaceConfigFile,
  resolveConfigWriteAfterWrite: (value?: unknown) => value ?? { mode: "auto" },
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
    writePersistedInstalledPluginIndexInstallRecordsWithLease:
      mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease,
  };
});

vi.mock("./installed-plugin-index-store-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./installed-plugin-index-store-write.js")>();
  return {
    ...actual,
    restorePersistedInstalledPluginIndexIfCurrent:
      mocks.restorePersistedInstalledPluginIndexIfCurrent,
  };
});

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: mocks.withPluginLifecycleLease,
}));

export function createRetainedMarkerFixture(stateDir: string, pluginId = "retained-fence") {
  const packageName = `@openclaw/${pluginId}`;
  const installPath = writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId,
    version: "1.0.0",
  });
  return {
    installPath,
    markerPath: resolveRetainedManagedNpmInstallMarkerPath(installPath),
    record: { source: "npm" as const, spec: `${packageName}@1.0.0`, installPath },
  };
}

export function setupInstallRecordCommitTests() {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    configFiles.clear();
    mocks.replaceConfigFile.mockImplementation(async (params: { nextConfig: OpenClawConfig }) =>
      configFiles.write(params.nextConfig),
    );
    mocks.restorePersistedInstalledPluginIndexIfCurrent.mockResolvedValue(true);
    mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease.mockResolvedValue({
      previous: null,
      revision: 1,
      mutation: {
        databasePath: "/tmp/openclaw.sqlite",
        before: null,
        after: { state_key: "plugins.installedIndex", value_json: "{}", updated_at_ms: 1 },
      },
    });
  });
}

export { mocks };
