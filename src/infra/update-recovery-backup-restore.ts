import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { UpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { clearOpenClawStateCopyLeases } from "../state/openclaw-state-copy-leases.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPath,
  openClawStateDatabaseCache,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { formatErrorMessage } from "./errors.js";
import { root as safeRoot } from "./fs-safe.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { isSqliteSchemaVersionError } from "./sqlite-user-version.js";
import { isUpdateCapturePath } from "./update-capture-paths.js";
import { preserveUpdateRecoveryCandidate } from "./update-recovery-backup-candidate.js";
import type { UpdateRecoveryRestoreResult } from "./update-recovery-backup-contract.js";
import { canonicalEntryPath, fileDigest, statOrMissing } from "./update-recovery-backup-files.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
} from "./update-run-driver.js";

export async function restorePreparedUpdateRecoveryBackup(
  prepared: {
    directory: string;
    manifest: UpdateRecoveryBackupManifest;
    payloads: ReadonlyMap<string, string>;
    assertCurrent: () => Promise<void>;
  },
  authority: { assertOwned: () => void },
): Promise<UpdateRecoveryRestoreResult> {
  const { manifest, payloads } = prepared;
  const self = readUpdateRunDriver();
  for (const driver of [manifest.creator, ...manifest.drivers]) {
    if (
      (!self || !sameUpdateRunDriver(driver, self)) &&
      inspectUpdateRunDriver(driver) !== "dead"
    ) {
      throw new Error(
        `Offline restore refused while a recorded update driver is alive or unobservable. Capture retained at ${path.join(prepared.directory, "manifest.json")}; let the other updater exit before retrying recovery.`,
      );
    }
  }

  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    await prepared.assertCurrent();
    authority.assertOwned();
    return await operation();
  };
  const capturedPaths = new Set([
    ...manifest.entries.map((entry) => entry.sourcePath),
    // Consolidated baseline snapshots replace their old WAL and journal companions.
    ...manifest.entries.flatMap((entry) =>
      entry.kind === "file" && entry.sqlite
        ? SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${entry.sourcePath}${suffix}`)
        : [],
    ),
    ...manifest.excludedRoots,
  ]);
  const pruneDirectory = async (pathname: string): Promise<void> => {
    const pin = await pinDirectory(pathname);
    try {
      if (pin.receipt.realPath !== pathname) {
        throw new Error(`Update recovery directory changed location: ${pathname}`);
      }
      const directory = await safeRoot(pathname);
      const remove = async (relativePath: string, isDirectory: boolean): Promise<boolean> => {
        const absolutePath = path.join(pathname, relativePath);
        if (
          capturedPaths.has(absolutePath) ||
          isUpdateCapturePath(absolutePath, manifest.stateDir)
        ) {
          return false;
        }
        let retained = false;
        if (isDirectory) {
          for (const child of await directory.list(relativePath, { withFileTypes: true })) {
            if (!(await remove(path.join(relativePath, child.name), child.isDirectory))) {
              retained = true;
            }
          }
        }
        if (retained) {
          return false;
        }
        await mutate(async () => {
          await pin.assertCurrent();
          authority.assertOwned();
          await directory.remove(relativePath);
        });
        return true;
      };
      for (const child of await directory.list("", { withFileTypes: true })) {
        const childPath = path.join(pathname, child.name);
        if (!capturedPaths.has(childPath) && !isUpdateCapturePath(childPath, manifest.stateDir)) {
          await remove(child.name, child.isDirectory);
        }
      }
      requireDirectorySync(await pin.sync(), "Update recovery directory");
    } finally {
      await pin.close();
    }
  };
  const sqlitePaths = manifest.entries.flatMap((entry) =>
    (entry.kind === "file" || entry.kind === "missing") && entry.sqlite ? [entry.sourcePath] : [],
  );
  // Agent drains release leases through shared state; finish every drain first.
  for (const pathname of sqlitePaths) {
    await prepared.assertCurrent();
    authority.assertOwned();
    await closeOpenClawAgentDatabasesAsync(pathname);
  }
  for (const pathname of sqlitePaths) {
    await prepared.assertCurrent();
    authority.assertOwned();
    closeOpenClawStateDatabaseByPath(pathname);
  }
  const candidate = await preserveUpdateRecoveryCandidate({
    directory: prepared.directory,
    manifest,
    assertCurrent: prepared.assertCurrent,
    assertOwned: authority.assertOwned,
  });
  let placed = false;
  try {
    const configLink = (entry: UpdateRecoveryBackupManifest["entries"][number]) =>
      Number(entry.kind === "symlink" && manifest.configPaths.includes(entry.sourcePath));
    for (const entry of manifest.entries.toSorted(
      (a, b) => configLink(a) - configLink(b) || a.sourcePath.length - b.sourcePath.length,
    )) {
      await prepared.assertCurrent();
      authority.assertOwned();
      if (entry.kind === "missing") {
        const current = await statOrMissing(entry.sourcePath);
        if (current?.isDirectory()) {
          // Only a migration-owned directory declaration grants recursive removal.
          if (entry.directory) {
            await pruneDirectory(entry.sourcePath);
            if ((await fs.readdir(entry.sourcePath)).length === 0) {
              await mutate(() => fs.rmdir(entry.sourcePath));
            }
          }
        } else if (current) {
          await mutate(() => fs.unlink(entry.sourcePath));
        }
        if (entry.sqlite) {
          for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
            await mutate(() => fs.rm(`${entry.sourcePath}${suffix}`, { force: true }));
          }
        }
        continue;
      }
      const current = await statOrMissing(entry.sourcePath);
      if (entry.kind === "directory") {
        if (current && !current.isDirectory()) {
          await mutate(() => fs.unlink(entry.sourcePath));
        }
        await mutate(() => fs.mkdir(entry.sourcePath, { recursive: true, mode: entry.mode }));
        await mutate(() => fs.chmod(entry.sourcePath, entry.mode));
        // Directory entries belong only to declared migration resources.
        await pruneDirectory(entry.sourcePath);
        continue;
      }
      await mutate(() =>
        fs.mkdir(path.dirname(entry.sourcePath), { recursive: true, mode: 0o700 }),
      );
      if (current?.isDirectory()) {
        throw new Error(
          `Update recovery destination contains newer directory state: ${entry.sourcePath}`,
        );
      }
      if (entry.kind === "symlink") {
        if (current) {
          await mutate(() => fs.unlink(entry.sourcePath));
        }
        await mutate(() => fs.symlink(entry.target, entry.sourcePath));
        continue;
      }
      const verifiedSource = payloads.get(entry.archivePath);
      if (!verifiedSource) {
        throw new Error(`Update recovery payload was not staged: ${entry.archivePath}`);
      }
      const temporary = `${entry.sourcePath}.update-recovery-${randomUUID()}`;
      try {
        if (entry.sqlite) {
          await publishVerifiedSqliteFile({
            sourceIdentity: await fs.lstat(verifiedSource),
            sourcePath: verifiedSource,
            targetPath: temporary,
            expectedContent: { sha256: entry.sha256, sizeBytes: entry.size },
            beforePublish: async () => {
              await prepared.assertCurrent();
              authority.assertOwned();
            },
          });
          await fs.chmod(temporary, entry.mode);
          // The current driver has closed every writer; old WAL pages cannot accompany the baseline.
          for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
            await mutate(() => fs.rm(`${entry.sourcePath}${suffix}`, { force: true }));
          }
        } else {
          await fs.copyFile(verifiedSource, temporary, fs.constants.COPYFILE_EXCL);
          await fs.chmod(temporary, entry.mode);
          const target = await fs.open(temporary, "r+");
          try {
            await target.sync();
          } finally {
            await target.close();
          }
        }
        const actual = await fileDigest(temporary);
        if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) {
          throw new Error(`Restored update recovery file failed verification: ${entry.sourcePath}`);
        }
        await mutate(() => fs.rename(temporary, entry.sourcePath));
        requireDirectorySync(
          await syncDirectory(path.dirname(entry.sourcePath)),
          "Update recovery destination",
        );
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    const sharedPath = canonicalEntryPath(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: manifest.stateDir }),
    );
    const sharedEntry = manifest.entries.find((entry) => entry.sourcePath === sharedPath);
    const restoredSharedPath =
      sharedEntry?.kind === "symlink" ? await fs.realpath(sharedPath) : sharedPath;
    if (
      manifest.entries.some(
        (entry) => entry.kind === "file" && entry.sqlite && entry.sourcePath === restoredSharedPath,
      )
    ) {
      // Restored leases would appear held by processes whose state no longer exists.
      await mutate(async () => {
        const restored = openNodeSqliteDatabase(resolveExistingSqliteFileUri(restoredSharedPath));
        try {
          clearOpenClawStateCopyLeases(restored);
        } finally {
          restored.close();
        }
      });
      const restoredPaths = new Set([sharedPath, restoredSharedPath]);
      const selectedPath = path.resolve(resolveOpenClawStateSqlitePath());
      if ((await fs.realpath(selectedPath)) === restoredSharedPath) {
        restoredPaths.add(selectedPath);
      }
      // Only the replaced shared file's obsolete schema failure is retired; other failures remain.
      for (const pathname of restoredPaths) {
        authority.assertOwned();
        if (
          isSqliteSchemaVersionError(
            openClawStateDatabaseCache.getOpenClawStateDatabaseRuntimeFailure(pathname),
          )
        ) {
          clearOpenClawStateDatabaseOpenFailure(pathname);
        }
      }
    }
    authority.assertOwned();
    placed = true;
    try {
      await candidate.retire();
    } catch (error) {
      candidate.warnings.push({
        kind: "candidate-retirement-failed",
        sourcePath: candidate.directory,
        resourceKind: "directory",
        message: `State restored; candidate cleanup failed: ${formatErrorMessage(error)}. Inspect retained artifacts before another update.`,
      });
    }
    return { warnings: candidate.warnings };
  } catch (cause) {
    throw new Error(
      `State restoration did not finish. Baseline: ${path.join(prepared.directory, "manifest.json")}; candidate: ${path.join(candidate.directory, "manifest.json")}. Keep the Gateway stopped and inspect both artifacts before manual recovery; automatic retry is refused.`,
      { cause },
    );
  } finally {
    await candidate.close().catch((error: unknown) => {
      if (!placed) {
        throw error;
      }
      candidate.warnings.push({
        kind: "candidate-retirement-failed",
        sourcePath: candidate.directory,
        resourceKind: "directory",
        message: `State restored; candidate handle cleanup failed: ${formatErrorMessage(error)}`,
      });
    });
  }
}
