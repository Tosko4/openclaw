import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({ convergence: vi.fn() }));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: mocks.convergence,
}));
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

describe("updater plugin commit cancellation", () => {
  it.each(["index", "config", "config-failed"] as const)(
    "preserves the index and config after %s refusal through the real commit owner",
    async (effect) => {
      await withOpenClawTestState({ label: `updater-plugin-${effect}` }, async (state) => {
        const cfg = { plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const originalConfig = await fs.readFile(state.configPath, "utf8");
        await writePersistedInstalledPluginIndexInstallRecords({}, { config: cfg, env: state.env });
        const controller = new AbortController();
        const refusal = new Error(`updater ${effect} refusal`);
        const assertCurrent = () => controller.signal.throwIfAborted();
        mocks.convergence.mockImplementationOnce(async () => {
          await Promise.resolve();
          if (effect === "index") {
            controller.abort(refusal);
          }
          return {
            changes: [],
            warnings: [],
            errored: false,
            smokeFailures: [],
            installRecords: { next: { source: "archive" } },
          };
        });
        const params = {
          root: state.root,
          channel: "stable" as const,
          configSnapshot: await readConfigFileSnapshot(),
          configWriteOptions: {
            beforeCommit: () => {
              if (effect === "config-failed") {
                throw refusal;
              }
              if (effect === "config") {
                controller.abort(refusal);
              }
            },
          },
          configChanged: true,
          pluginInstallRecords: {},
          timeoutMs: 1_000,
          json: true,
          assertCurrent,
        };
        const update = () => updatePluginsAfterCoreUpdate(params);
        await expect(
          effect === "config-failed"
            ? withPluginLifecycleLease({ assertCurrent }, update)
            : update(),
        ).rejects.toBe(refusal);
        if (effect === "config-failed") {
          expect(controller.signal.aborted).toBe(false);
        }
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
      });
    },
  );
});
