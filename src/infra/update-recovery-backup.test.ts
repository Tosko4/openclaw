import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import * as pluginBackupResources from "../plugins/doctor-contract-registry.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { preflightUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import { restorePreparedUpdateRecoveryBackup } from "./update-recovery-backup-restore.js";
import {
  createUpdateRecoveryBackup,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import { createUpdateRun } from "./update-run-ledger.js";
import { getUpdateRunAsync } from "./update-run-reader.js";

const authority = { assertOwned() {} };
function requireDriver(pid = process.pid) {
  const driver = readUpdateRunDriver(pid);
  if (!driver) {
    throw new Error("Recovery fixture requires an observable driver identity");
  }
  return driver;
}
const execFileAsync = promisify(execFile);
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

async function fixture(state: OpenClawTestState, legacySchema = true) {
  const coordinatorDir = state.path("coordinator");
  await fs.mkdir(coordinatorDir, { mode: 0o700 });
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  closeOpenClawStateDatabaseForTest();
  const databasePath = state.statePath("state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE workshop(workspace_dir TEXT);
    INSERT INTO workshop(rowid,workspace_dir) VALUES (9,'original-workspace');
    INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
      VALUES ('test','pending-delivery','pending','{}',1,1);
    INSERT INTO state_leases(scope,lease_key,owner,created_at,updated_at)
      VALUES ('test','retained','fixture',1,1);
    INSERT INTO agent_database_leases(lease_id,agent_id,path,owner_pid,opened_at)
      VALUES ('source-agent','main','agents/main/agent/openclaw-agent.sqlite',1,1);
  `);
  if (legacySchema) {
    database.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version=15, app_version='2026.9.2' WHERE meta_key='primary';
    `);
  }
  await fs.mkdir(state.path("install"), { mode: 0o700 });
  return { database, databasePath, installRoot: state.path("install"), runId: run.runId };
}

describe("update recovery backup", () => {
  it("preserves an explicitly raw SQLite sidecar through a later publication failure", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { database, installRoot, runId } = await fixture(state, false);
      const store = state.path("plugin-store");
      await fs.mkdir(store);
      const sqlitePath = path.join(store, "index.sqlite");
      const rawPath = `${sqlitePath}-shm`;
      const laterPath = path.join(store, "zz-later-publication.data");
      const sqlite = new (requireNodeSqlite().DatabaseSync)(sqlitePath);
      try {
        sqlite.exec(
          "PRAGMA journal_mode=DELETE; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('unchanged');",
        );
      } finally {
        sqlite.close();
      }
      await fs.writeFile(rawPath, "baseline raw sidecar");
      await fs.writeFile(laterPath, "baseline later file");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([
          { path: store, kind: "directory" },
          { path: rawPath, kind: "file" },
        ]);
      try {
        const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
        const baseline = await verifyUpdateRecoveryBackup(ref);
        expect(baseline.entries.find((entry) => entry.sourcePath === rawPath)).toMatchObject({
          kind: "file",
          sqlite: false,
        });
        await fs.writeFile(rawPath, "candidate raw sidecar");
        await fs.writeFile(laterPath, "candidate later file");
        database.close();
        const rename = fs.rename;
        let publicationFailed = false;
        const publish = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
          if (target === laterPath) {
            publicationFailed = true;
            throw Object.assign(new Error("Synthetic later publication failure"), { code: "EIO" });
          }
          await rename(source, target);
        });
        try {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
        } finally {
          publish.mockRestore();
        }
        expect(publicationFailed).toBe(true);
        expect(await fs.readFile(rawPath, "utf8")).toBe("baseline raw sidecar");
        const retained = (await fs.readdir(ref.directory)).filter((name) =>
          name.startsWith(".restore-"),
        );
        expect(retained).toHaveLength(1);
        const candidateDirectory = path.join(ref.directory, retained[0]!);
        const candidate = parseUpdateRecoveryBackupManifest(
          await fs.readFile(path.join(candidateDirectory, "manifest.json"), "utf8"),
        );
        const raw = candidate.entries.find((entry) => entry.sourcePath === rawPath);
        expect(raw).toMatchObject({ kind: "file", sqlite: false });
        if (raw?.kind !== "file") {
          throw new Error("Candidate recovery omitted its declared raw sidecar");
        }
        expect(await fs.readFile(path.join(candidateDirectory, raw.archivePath), "utf8")).toBe(
          "candidate raw sidecar",
        );
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toEqual(baseline);
      } finally {
        declaration.mockRestore();
        if (database.isOpen) {
          database.close();
        }
      }
    });
  });

  it.each(["published", "content"] as const)(
    "restores a captured schema after the candidate advances its %s version beyond the driver",
    async (marker) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, databasePath, installRoot, runId } = await fixture(state, false);
        try {
          const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          openOpenClawStateDatabase({ env: state.env });
          const future = OPENCLAW_STATE_SCHEMA_VERSION + 1;
          database.exec("UPDATE workshop SET workspace_dir='future-workspace'");
          if (marker === "published") {
            database.exec(
              `PRAGMA user_version=${future}; UPDATE schema_meta SET schema_version=${future} WHERE meta_key='primary';`,
            );
          } else {
            database
              .prepare(
                "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES (?,?,?) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
              )
              .run(CONTENT_VERSION_KEY, String(future), Date.now());
          }
          database.close();
          await expect(getUpdateRunAsync(runId, { env: state.env })).rejects.toThrow(
            "uses newer schema version",
          );
          const result = await restoreUpdateRecoveryBackup(ref, authority);
          expect(result.warnings).toContainEqual({
            kind: "discarded-post-capture-writes",
            sourcePath: databasePath,
            resourceKind: "sqlite",
          });
          const restored = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
          try {
            expect(readStateSchemaContentVersion(restored)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
            expect(restored.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
              rowid: 9,
              workspace_dir: "original-workspace",
            });
          } finally {
            restored.close();
          }
          await expect(getUpdateRunAsync(runId, { env: state.env })).resolves.toMatchObject({
            origin: { updateRecoveryCapture: { manifestSha256: ref.manifestSha256 } },
          });
        } finally {
          if (database.isOpen) {
            database.close();
          }
        }
      });
    },
  );

  it.each(["live", "unknown"] as const)(
    "refuses offline restore while a recorded foreign driver is %s",
    async (condition) => {
      const child =
        condition === "live"
          ? spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            })
          : undefined;
      try {
        if (child) {
          await once(child, "message", { signal: AbortSignal.timeout(3_000) });
        }
        const driver = child
          ? requireDriver(child.pid ?? -1)
          : { ...requireDriver(), host: "unobservable-host.invalid" };
        await withOpenClawTestState(
          { layout: "state-only", scenario: "minimal" },
          async (state) => {
            const { database, databasePath, installRoot, runId } = await fixture(state, false);
            try {
              const ref = await createUpdateRecoveryBackup({
                ...authority,
                installRoot,
                runId,
                drivers: [driver],
              });
              database.exec("UPDATE workshop SET workspace_dir='candidate-workspace'");
              database.close();
              await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
                "recorded update driver is alive or unobservable",
              );
              expect(
                (await fs.readdir(ref.directory)).some((name) => name.startsWith(".restore-")),
              ).toBe(false);
              const current = new (requireNodeSqlite().DatabaseSync)(databasePath, {
                readOnly: true,
              });
              try {
                expect(current.prepare("SELECT workspace_dir FROM workshop").get()).toEqual({
                  workspace_dir: "candidate-workspace",
                });
              } finally {
                current.close();
              }
            } finally {
              if (database.isOpen) {
                database.close();
              }
            }
          },
        );
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    },
  );

  it.each(["direct", "symlink"] as const)(
    "refuses a declared capture root containing its recovery store (%s)",
    async (route) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot, runId } = await fixture(state, false);
        const ancestor = path.dirname(state.stateDir);
        const root = route === "symlink" ? state.path("migration-root") : ancestor;
        if (route === "symlink") {
          await fs.symlink(ancestor, root, "junction");
        }
        const declaration = vi
          .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
          .mockResolvedValue([{ path: root, kind: "directory" }]);
        try {
          await expect(
            preflightUpdateRecoveryBackup({ ...authority, installRoot, runId }),
          ).rejects.toThrow("root containing its backup store");
          await expect(fs.lstat(`${state.stateDir}.update-captures`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          declaration.mockRestore();
          database.close();
        }
      });
    },
  );

  it.each([false, true])(
    "reports discarded store writes and retains every candidate until publication completes (later failure=%s)",
    async (laterFailure) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, databasePath, installRoot, runId } = await fixture(state, false);
        const firstPath = state.statePath("a-first.raw");
        const lastPath = state.statePath("z-final.raw");
        const directoryPath = state.statePath("plugin-store");
        await fs.mkdir(directoryPath);
        await fs.writeFile(path.join(directoryPath, "existing"), "baseline directory value");
        await fs.writeFile(firstPath, "baseline first");
        await fs.writeFile(lastPath, "baseline last");
        const declaration = vi
          .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
          .mockResolvedValue([
            { path: firstPath, kind: "file" },
            { path: lastPath, kind: "file" },
            { path: directoryPath, kind: "directory" },
          ]);
        try {
          const ref = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          const baseline = await fs.readFile(ref.manifestPath, "utf8");
          database.exec("UPDATE workshop SET workspace_dir='candidate-workspace'");
          await fs.writeFile(firstPath, "candidate first");
          await fs.writeFile(lastPath, "candidate last");
          await fs.writeFile(path.join(directoryPath, "added"), "candidate directory value");
          database.close();
          const rename = fs.rename;
          const publication = laterFailure
            ? vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
                if (target === lastPath) {
                  throw Object.assign(new Error("Synthetic later publication failure"), {
                    code: "EIO",
                  });
                }
                await rename(source, target);
              })
            : undefined;
          try {
            if (laterFailure) {
              await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
            } else {
              const restored = await restoreUpdateRecoveryBackup(ref, authority);
              expect(restored).toMatchObject({
                warnings: expect.arrayContaining([
                  {
                    kind: "discarded-post-capture-writes",
                    sourcePath: databasePath,
                    resourceKind: "sqlite",
                  },
                  {
                    kind: "discarded-post-capture-writes",
                    sourcePath: firstPath,
                    resourceKind: "file",
                  },
                  {
                    kind: "discarded-post-capture-writes",
                    sourcePath: lastPath,
                    resourceKind: "file",
                  },
                  {
                    kind: "discarded-post-capture-writes",
                    sourcePath: directoryPath,
                    resourceKind: "directory",
                  },
                ]),
              });
            }
          } finally {
            publication?.mockRestore();
          }
          expect(await fs.readFile(firstPath, "utf8")).toBe("baseline first");
          expect(await fs.readFile(ref.manifestPath, "utf8")).toBe(baseline);
          await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId });
          const retained = (await fs.readdir(ref.directory)).filter((name) =>
            name.startsWith(".restore-"),
          );
          expect(retained).toHaveLength(laterFailure ? 1 : 0);
          if (laterFailure) {
            const directory = path.join(ref.directory, retained[0]!);
            const candidate = parseUpdateRecoveryBackupManifest(
              await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
            );
            for (const [sourcePath, value] of [
              [firstPath, "candidate first"],
              [lastPath, "candidate last"],
              [path.join(directoryPath, "added"), "candidate directory value"],
            ]) {
              const entry = candidate.entries.find((item) => item.sourcePath === sourcePath);
              if (entry?.kind !== "file") {
                throw new Error("Candidate recovery fixture is missing its captured file");
              }
              expect(await fs.readFile(path.join(directory, entry.archivePath), "utf8")).toBe(
                value,
              );
            }
            const shared = candidate.entries.find((entry) => entry.sourcePath === databasePath);
            if (shared?.kind !== "file") {
              throw new Error("Candidate recovery fixture is missing its captured database");
            }
            const preserved = new (requireNodeSqlite().DatabaseSync)(
              path.join(directory, shared.archivePath),
              { readOnly: true },
            );
            try {
              expect(preserved.prepare("SELECT workspace_dir FROM workshop").get()).toEqual({
                workspace_dir: "candidate-workspace",
              });
            } finally {
              preserved.close();
            }
            await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
              /earlier restoration retained candidate/,
            );
          } else {
            expect(await fs.readFile(lastPath, "utf8")).toBe("baseline last");
            await expect(fs.stat(path.join(directoryPath, "added"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            const restored = new (requireNodeSqlite().DatabaseSync)(databasePath, {
              readOnly: true,
            });
            try {
              expect(restored.prepare("SELECT workspace_dir FROM workshop").get()).toEqual({
                workspace_dir: "original-workspace",
              });
            } finally {
              restored.close();
            }
          }
        } finally {
          declaration.mockRestore();
          if (database.isOpen) {
            database.close();
          }
        }
      });
    },
  );

  it("waits for native agent closure before closing shared state or restoring files", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      const agentPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const shared = openOpenClawStateDatabase({ env: state.env, path: sharedPath });
      const original = "original config bytes\n";
      const payloadPath = state.path("verified-config");
      const capturePath = state.path("capture");
      await fs.mkdir(capturePath);
      await fs.writeFile(payloadPath, original);
      await fs.writeFile(state.configPath, "current config bytes\n");
      const closing = createDeferredCore();
      const release = createDeferredCore();
      const drain = vi
        .spyOn(agentDatabaseLifecycle, "closeOpenClawAgentDatabasesAsync")
        .mockImplementation(async (pathname) => {
          if (pathname === agentPath) {
            closing.resolve();
            await release.promise;
            // The agent's closing lease still needs the shared connection.
            expect(shared.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
          }
        });
      const restore = restorePreparedUpdateRecoveryBackup(
        {
          directory: capturePath,
          manifest: {
            schemaVersion: 1,
            kind: "update-recovery",
            runId: "native-drain",
            installRoot: state.path("install"),
            stateDir: state.stateDir,
            configPath: state.configPath,
            configPaths: [state.configPath],
            creator: requireDriver(),
            drivers: [],
            warnings: [],
            createdAt: "2026-09-10T00:00:00.000Z",
            roots: [sharedPath, agentPath, state.configPath],
            excludedRoots: [],
            protectedPaths: [sharedPath, agentPath, state.configPath],
            entries: [
              { kind: "missing", sourcePath: sharedPath, sqlite: true, directory: false },
              { kind: "missing", sourcePath: agentPath, sqlite: true, directory: false },
              {
                kind: "file",
                sourcePath: state.configPath,
                archivePath: "payload/0",
                size: Buffer.byteLength(original),
                sha256: createHash("sha256").update(original).digest("hex"),
                sqlite: false,
                mode: 0o600,
              },
            ],
          },
          payloads: new Map([["payload/0", payloadPath]]),
          assertCurrent: async () => {},
        },
        authority,
      );
      try {
        expect(
          await Promise.race([
            closing.promise.then(() => "closing"),
            restore.then(() => "restored"),
          ]),
        ).toBe("closing");
        expect(await fs.readFile(state.configPath, "utf8")).toBe("current config bytes\n");
        expect(shared.db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
        release.resolve();
        await restore;
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        expect(shared.db.isOpen).toBe(false);
      } finally {
        release.resolve();
        await restore;
        drain.mockRestore();
      }
    });
  });

  it.each([
    { cleanupFailure: false, directory: false },
    { cleanupFailure: true, directory: false },
    { cleanupFailure: false, directory: true },
  ])(
    "restores the original WAL schema and rows after writers close (cleanup failure=$cleanupFailure, directory=$directory)",
    async ({ cleanupFailure, directory }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const capturedState = await fixture(state);
        let database = capturedState.database;
        const { databasePath, installRoot, runId } = capturedState;
        const configBefore = await fs.readFile(state.configPath, "utf8");
        const ordinaryFile = await state.writeText("notes-wal", "ordinary file before update\n");
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const workspaceDatabasePath = path.join(state.workspaceDir, "unrelated.sqlite");
        const workspaceDatabase = new (requireNodeSqlite().DatabaseSync)(workspaceDatabasePath);
        workspaceDatabase.exec("CREATE TABLE unrelated(value TEXT)");
        workspaceDatabase.close();
        const declaration = directory
          ? vi
              .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
              .mockResolvedValue([{ path: path.dirname(databasePath), kind: "directory" }])
          : undefined;
        try {
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId,
          });
          const manifest = await verifyUpdateRecoveryBackup(ref);
          expect(manifest.kind).toBe("update-recovery");
          const sharedPayload = manifest.entries.find(
            (entry) => entry.kind === "file" && entry.sourcePath === databasePath,
          );
          if (!sharedPayload || sharedPayload.kind !== "file") {
            throw new Error("Fixture has no shared database payload");
          }
          const captured = new (requireNodeSqlite().DatabaseSync)(
            path.join(ref.directory, sharedPayload.archivePath),
            { readOnly: true },
          );
          try {
            expect(captured.prepare("SELECT lease_key FROM state_leases").all()).toEqual([
              { lease_key: "retained" },
            ]);
            expect(captured.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
              { lease_id: "source-agent" },
            ]);
          } finally {
            captured.close();
          }
          expect(manifest.entries.some((entry) => entry.sourcePath.startsWith(ref.directory))).toBe(
            false,
          );
          expect(
            manifest.entries.some(
              (entry) =>
                entry.sourcePath === ordinaryFile || entry.sourcePath.endsWith("/unrelated.sqlite"),
            ),
          ).toBe(false);
          database.exec(
            "ALTER TABLE workshop RENAME COLUMN workspace_dir TO owner_agent_id; DELETE FROM delivery_queue_entries; PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16 WHERE meta_key='primary';",
          );
          const nextConfig = '{"gateway":{"mode":"remote"}}\n';
          await fs.writeFile(state.configPath, nextConfig);
          await fs.writeFile(ordinaryFile, "changed by migration\n");
          const newerNote = await state.writeText("operator-note.md", "written after the backup\n");
          const missingDatabase = manifest.entries.find(
            (entry) =>
              entry.kind === "missing" &&
              entry.sqlite &&
              entry.sourcePath.endsWith("openclaw-agent.sqlite"),
          );
          expect(missingDatabase).toBeDefined();
          if (!missingDatabase) {
            throw new Error("Fixture has no missing agent database");
          }
          await fs.mkdir(path.dirname(missingDatabase.sourcePath), { recursive: true });
          await fs.writeFile(missingDatabase.sourcePath, "new database placeholder");
          await fs.writeFile(`${missingDatabase.sourcePath}-wal`, "new sidecar");
          database.close();
          let cleanupFailed = false;
          const remove = fs.rm;
          const cleanup = cleanupFailure
            ? vi.spyOn(fs, "rm").mockImplementation(async (pathname, options) => {
                if (
                  typeof pathname === "string" &&
                  path.dirname(pathname) === ref.directory &&
                  path.basename(pathname).startsWith(".verify-")
                ) {
                  cleanupFailed = true;
                  throw new Error("Synthetic verification staging cleanup failure");
                }
                await remove(pathname, options);
              })
            : undefined;
          try {
            await restoreUpdateRecoveryBackup(ref, authority);
          } finally {
            cleanup?.mockRestore();
          }
          database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
          expect(cleanupFailed).toBe(cleanupFailure);
          expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
            rowid: 9,
            workspace_dir: "original-workspace",
          });
          expect(database.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([
            { id: "pending-delivery" },
          ]);
          expect(database.prepare("SELECT lease_key FROM state_leases").all()).toEqual([]);
          expect(database.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
          expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
          expect(await fs.readFile(ordinaryFile, "utf8")).toBe("changed by migration\n");
          expect(await fs.readFile(newerNote, "utf8")).toBe("written after the backup\n");
          await expect(fs.lstat(missingDatabase.sourcePath)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(fs.lstat(`${missingDatabase.sourcePath}-wal`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({
            runId,
          });
        } finally {
          declaration?.mockRestore();
          if (database.isOpen) {
            database.close();
          }
        }
      });
    },
  );

  it("keeps a held plugin lease in capture but permits immediate acquisition after restore", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const capturedState = await fixture(state, false);
      let database = capturedState.database;
      const { databasePath, installRoot, runId } = capturedState;
      const pluginPath = state.path("plugin.sqlite");
      let plugin = new (requireNodeSqlite().DatabaseSync)(pluginPath);
      plugin.exec(`
        CREATE TABLE state_leases (lease_key TEXT);
        INSERT INTO state_leases VALUES ('plugin-data');
        CREATE TABLE agent_database_leases (lease_id TEXT);
        INSERT INTO agent_database_leases VALUES ('plugin-agent-data');
      `);
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: pluginPath, kind: "sqlite" }]);
      try {
        const ref = await withPluginLifecycleLease({ waitMs: 0 }, async (lease) => {
          const capture = await createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          lease.assertOwned();
          return capture;
        });
        const manifest = await verifyUpdateRecoveryBackup(ref);
        const entry = manifest.entries.find(
          (item) => item.kind === "file" && item.sourcePath === databasePath,
        );
        if (!entry || entry.kind !== "file") {
          throw new Error("Fixture has no shared database payload");
        }
        const captured = new (requireNodeSqlite().DatabaseSync)(
          path.join(ref.directory, entry.archivePath),
          { readOnly: true },
        );
        try {
          expect(
            captured
              .prepare("SELECT lease_key FROM state_leases WHERE scope='core:plugin-lifecycle'")
              .all(),
          ).toEqual([{ lease_key: "global" }]);
          expect(captured.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([
            { lease_id: "source-agent" },
          ]);
        } finally {
          captured.close();
        }
        expect(
          database
            .prepare("SELECT lease_key FROM state_leases WHERE scope='core:plugin-lifecycle'")
            .all(),
        ).toEqual([]);
        database.exec("UPDATE workshop SET workspace_dir='migrated'");
        plugin.exec("DELETE FROM state_leases; DELETE FROM agent_database_leases");
        database.close();
        plugin.close();

        await restoreUpdateRecoveryBackup(ref, authority);
        database = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
        plugin = new (requireNodeSqlite().DatabaseSync)(pluginPath, { readOnly: true });

        await expect(
          withPluginLifecycleLease({ waitMs: 0 }, async (lease) => lease.assertOwned()),
        ).resolves.toBeUndefined();
        expect(database.prepare("SELECT lease_key FROM state_leases").all()).toEqual([]);
        expect(database.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
        expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
          rowid: 9,
          workspace_dir: "original-workspace",
        });
        expect(plugin.prepare("SELECT * FROM state_leases").all()).toEqual([
          { lease_key: "plugin-data" },
        ]);
        expect(plugin.prepare("SELECT * FROM agent_database_leases").all()).toEqual([
          { lease_id: "plugin-agent-data" },
        ]);
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toEqual(manifest);
      } finally {
        declaration.mockRestore();
        if (database.isOpen) {
          database.close();
        }
        if (plugin.isOpen) {
          plugin.close();
        }
      }
    });
  });

  it.each(["changed bytes", "symlink"] as const)(
    "refuses %s in a payload before changing any live file",
    async (damage) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot, runId } = await fixture(state);
        try {
          const ref = await createUpdateRecoveryBackup({
            ...authority,
            installRoot,
            runId,
          });
          const manifest = await verifyUpdateRecoveryBackup(ref);
          const payload = manifest.entries.find((entry) => entry.kind === "file" && entry.sqlite);
          if (!payload || payload.kind !== "file") {
            throw new Error("Fixture has no SQLite payload");
          }
          const payloadPath = path.join(ref.directory, payload.archivePath);
          if (damage === "changed bytes") {
            await fs.writeFile(payloadPath, "corrupted");
          } else {
            const moved = `${payloadPath}.moved`;
            await fs.rename(payloadPath, moved);
            await fs.symlink(moved, payloadPath);
          }
          await fs.writeFile(state.configPath, "newer config bytes");
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow();
          expect(await fs.readFile(state.configPath, "utf8")).toBe("newer config bytes");
          expect(database.prepare("SELECT rowid FROM workshop").get()).toEqual({ rowid: 9 });
        } finally {
          database.close();
        }
      });
    },
  );

  it.each(["corrupt database", "orphan WAL"] as const)(
    "refuses a declared extensionless SQLite resource with %s before migration",
    async (failure) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const { database, installRoot, runId } = await fixture(state);
        const databasePath = state.path("external-index");
        const artifact = failure === "orphan WAL" ? `${databasePath}-wal` : databasePath;
        await fs.writeFile(artifact, "retained original bytes");
        const declaration = vi
          .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
          .mockResolvedValue([{ path: databasePath, kind: "sqlite" }]);
        try {
          const configBefore = await fs.readFile(state.configPath, "utf8");
          const capture = createUpdateRecoveryBackup({ ...authority, installRoot, runId });
          if (failure === "orphan WAL") {
            await expect(capture).rejects.toThrow(
              `SQLite database has an orphaned sidecar: ${artifact}`,
            );
          } else {
            await expect(capture).rejects.toMatchObject({
              cause: expect.objectContaining({ message: expect.stringContaining(databasePath) }),
            });
          }
          expect(await fs.readFile(artifact, "utf8")).toBe("retained original bytes");
          expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
          expect(database.prepare("SELECT rowid,workspace_dir FROM workshop").get()).toEqual({
            rowid: 9,
            workspace_dir: "original-workspace",
          });
          expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
        } finally {
          declaration.mockRestore();
          database.close();
        }
      });
    },
  );
});

async function runLanceDb(databasePath: string, operation: string): Promise<string> {
  // The plugin owns this dependency; separate processes release native database handles.
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { connect } from "@lancedb/lancedb";
const connection = await connect(process.argv[1]);
try {
  ${operation}
} finally {
  connection.close();
}`,
      databasePath,
    ],
    { cwd: fileURLToPath(new URL("../../extensions/memory-lancedb", import.meta.url)) },
  );
  return result.stdout.trim();
}

describe("update recovery database directories", () => {
  it("refuses a directory replaced by an outside symlink during pruning", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = state.path("database");
      const outsidePath = state.path("outside");
      await fs.mkdir(databasePath);
      await fs.mkdir(outsidePath);
      await fs.writeFile(path.join(databasePath, "original"), "captured data");
      await fs.writeFile(path.join(outsidePath, "original"), "unrelated original");
      await fs.writeFile(path.join(outsidePath, "new"), "unrelated new data");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        await fs.mkdir(state.path("install"), { mode: 0o700 });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: run.runId,
        });
        await fs.writeFile(path.join(databasePath, "new"), "migration data");
        const readdir = fs.readdir;
        let swapped = false;
        const listing = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          const result = await readdir(...args);
          if (String(args[0]) === databasePath && !swapped) {
            swapped = true;
            await fs.rename(databasePath, state.path("moved-database"));
            await fs.symlink(outsidePath, databasePath, "junction");
          }
          return result;
        });
        try {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            /changed|alias/,
          );
          expect(swapped).toBe(true);
          expect(await fs.readFile(path.join(outsidePath, "original"), "utf8")).toBe(
            "unrelated original",
          );
          expect(await fs.readFile(path.join(outsidePath, "new"), "utf8")).toBe(
            "unrelated new data",
          );
        } finally {
          listing.mockRestore();
        }
      } finally {
        declaration.mockRestore();
      }
    });
  });

  it("restores captured LanceDB schema and rows without newer manifests or changes outside its directory", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const databasePath = state.path("memory", "lancedb");
      await runLanceDb(
        databasePath,
        `const table = await connection.createTable("memories", [{ id: "original", text: "captured memory" }]);
table.close();`,
      );
      const retainedCapture = path.join(databasePath, "retained-manual-capture");
      await fs.mkdir(retainedCapture, { mode: 0o700 });
      await fs.writeFile(
        path.join(retainedCapture, UPDATE_CAPTURE_PRIVACY_MARKER),
        UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
      );
      const retainedFile = path.join(retainedCapture, "private-state.txt");
      await fs.writeFile(retainedFile, "retained original recovery state");
      const versionsPath = path.join(databasePath, "memories.lance", "_versions");
      const capturedManifests = (await fs.readdir(versionsPath)).toSorted();
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        await fs.mkdir(state.path("install"), { mode: 0o700 });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: run.runId,
        });
        const manifest = await verifyUpdateRecoveryBackup(ref);
        expect(manifest.entries).toContainEqual({
          kind: "directory",
          sourcePath: databasePath,
          mode: (await fs.stat(databasePath)).mode & 0o777,
        });
        expect(
          manifest.entries.some(
            (entry) =>
              entry.sourcePath === retainedCapture ||
              entry.sourcePath.startsWith(`${retainedCapture}${path.sep}`),
          ),
        ).toBe(false);
        await runLanceDb(
          databasePath,
          `const table = await connection.openTable("memories");
try {
  await table.addColumns([{ name: "agentId", valueSql: "'main'" }]);
  await table.add([{ id: "new", text: "migration memory", agentId: "main" }]);
} finally {
  table.close();
}`,
        );
        expect((await fs.readdir(versionsPath)).length).toBeGreaterThan(capturedManifests.length);
        const unrelatedPath = state.path("memory", "operator-note.txt");
        await fs.writeFile(unrelatedPath, "new sibling data");
        const outsidePath = state.path("unrelated-database");
        await fs.mkdir(outsidePath);
        await fs.writeFile(path.join(outsidePath, "keep.txt"), "outside link target");
        await fs.symlink(outsidePath, path.join(databasePath, "new-link"), "junction");
        await fs.mkdir(path.join(databasePath, "new-directory"));
        await fs.writeFile(path.join(databasePath, "new-directory", "new-data"), "migration data");

        await restoreUpdateRecoveryBackup(ref, authority);

        const restored = JSON.parse(
          await runLanceDb(
            databasePath,
            `const table = await connection.openTable("memories");
try {
  console.log(JSON.stringify({
    columns: (await table.schema()).fields.map((field) => field.name),
    rows: await table.query().toArray(),
    version: await table.version(),
  }));
} finally {
  table.close();
}`,
          ),
        );
        expect(restored).toEqual({
          columns: ["id", "text"],
          rows: [{ id: "original", text: "captured memory" }],
          version: 1,
        });
        expect((await fs.readdir(versionsPath)).toSorted()).toEqual(capturedManifests);
        expect(await fs.readFile(retainedFile, "utf8")).toBe("retained original recovery state");
        expect(
          await fs.readFile(path.join(retainedCapture, UPDATE_CAPTURE_PRIVACY_MARKER), "utf8"),
        ).toBe(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT);
        await expect(fs.lstat(path.join(databasePath, "new-directory"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.lstat(path.join(databasePath, "new-link"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await fs.readFile(unrelatedPath, "utf8")).toBe("new sibling data");
        expect(await fs.readFile(path.join(outsidePath, "keep.txt"), "utf8")).toBe(
          "outside link target",
        );
      } finally {
        declaration.mockRestore();
      }
    });
  });
});
