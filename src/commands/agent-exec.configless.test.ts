import fs from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { getConfigProviderUseBindings } from "../config/resolution-facts.js";
import {
  readLegacyMigrationReceipt,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../infra/state-migrations.receipts.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildExecRunConfig, resolveExecBaseConfig } from "./agent-exec-input.js";

describe("agent exec configless workspace ownership", () => {
  it.each([
    { name: "environment-only auth", options: { authEnvOnly: true } },
    { name: "isolated mode", options: { isolated: true } },
  ])("materializes the main-agent roster for $name", async ({ options }) => {
    const config = buildExecRunConfig({
      base: await resolveExecBaseConfig(options),
      cwd: "/run/here",
    });

    expect(
      resolveRunWorkspaceDir({
        agentId: "main",
        config,
        workspaceDir: "/run/here",
      }),
    ).toMatchObject({
      agentId: "main",
      workspaceDir: resolve("/run/here"),
    });
  });
});

describe("agent exec --config provider binding receipts", () => {
  it.each([
    {
      completedFile: "default",
      expectedBindings: {
        "byteplus-plan": {
          apiKey: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
        },
      },
    },
    { completedFile: "custom", expectedBindings: {} },
  ])(
    "uses only the selected file when the $completedFile receipt is complete",
    async (scenario) => {
      await withOpenClawTestState(
        {
          label: "agent-exec-config-receipts",
          env: {
            OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(
              new URL("../../extensions/", import.meta.url),
            ),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            BYTEPLUS_API_KEY: "fixture-byteplus-key",
          },
        },
        async (state) => {
          await state.writeConfig({});
          const customPath = await state.writeJson("custom.json", {
            agents: {
              defaults: { model: "byteplus-plan/ark-code-latest" },
              entries: { main: {} },
            },
          });
          const completedPath = scenario.completedFile === "custom" ? customPath : state.configPath;
          const migrationKind = "selected-shared-provider-bindings:v1";
          const sourceKey = resolveLegacyMigrationSourceKey(migrationKind, completedPath);
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              recordLegacyMigrationReceipt(db, {
                sourceKey,
                migrationKind,
                sourcePath: completedPath,
                targetTable: "migration_sources",
                sourceSha256: null,
                sourceSizeBytes: null,
                sourceRecordCount: null,
                runId: sourceKey,
                now: 1,
                reportJson: JSON.stringify({ selectionVersion: 2 }),
              }),
            { env: state.env },
          );
          const filesBefore = await Promise.all(
            [state.configPath, customPath].map((configPath) => fs.readFile(configPath, "utf8")),
          );
          const receiptBefore = readLegacyMigrationReceipt(sourceKey, state.env);

          const config = await resolveExecBaseConfig({ config: customPath });

          expect(getConfigProviderUseBindings(config)).toEqual(scenario.expectedBindings);
          expect(
            await Promise.all(
              [state.configPath, customPath].map((configPath) => fs.readFile(configPath, "utf8")),
            ),
          ).toEqual(filesBefore);
          expect(readLegacyMigrationReceipt(sourceKey, state.env)).toEqual(receiptBefore);
          const pendingPath = scenario.completedFile === "custom" ? state.configPath : customPath;
          expect(
            readLegacyMigrationReceipt(
              resolveLegacyMigrationSourceKey(migrationKind, pendingPath),
              state.env,
            ),
          ).toBeNull();
        },
      );
    },
  );
});
