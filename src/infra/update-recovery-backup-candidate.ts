import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { isSqliteSnapshotFile } from "./sqlite-file-header.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { isUpdateCapturePath } from "./update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import type { UpdateRecoveryRestoreWarning } from "./update-recovery-backup-contract.js";
import { fileDigest, MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";

type Entry = UpdateRecoveryBackupManifest["entries"][number];

function within(pathname: string, root: string): boolean {
  const relative = path.relative(root, pathname);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Keep the entire candidate as an immutable backup artifact until every baseline resource is placed. */
export async function preserveUpdateRecoveryCandidate(params: {
  directory: string;
  manifest: UpdateRecoveryBackupManifest;
  assertCurrent: () => Promise<void>;
  assertOwned: () => void;
}): Promise<{
  directory: string;
  warnings: UpdateRecoveryRestoreWarning[];
  retire: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const { manifest } = params;
  if ((await fs.readdir(params.directory)).some((name) => name.startsWith(".restore-"))) {
    throw new Error(
      `An earlier restoration retained candidate resources at ${params.directory}; inspect both generations before another restore.`,
    );
  }
  const directory = path.join(params.directory, `.restore-${randomUUID()}`);
  await params.assertCurrent();
  params.assertOwned();
  await createPrivateSqliteDirectory(directory);
  const pin = await pinDirectory(directory);
  let prepared = false;
  try {
    await fs.writeFile(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
      { flag: "wx", mode: 0o600 },
    );
    await createPrivateSqliteDirectory(path.join(directory, "payload"));
    const baseline = new Map(manifest.entries.map((entry) => [entry.sourcePath, entry]));
    const entries = new Map<string, Entry>();
    const excludedRoots = [...manifest.excludedRoots];
    const copy = async (pathname: string): Promise<void> => {
      if (isUpdateCapturePath(pathname, manifest.stateDir)) {
        excludedRoots.push(pathname);
        return;
      }
      const excluded = manifest.excludedRoots.find((root) => within(pathname, root));
      if (
        entries.has(pathname) ||
        (excluded &&
          !manifest.protectedPaths.some((root) => within(pathname, root) && within(root, excluded)))
      ) {
        return;
      }
      await params.assertCurrent();
      await pin.assertCurrent();
      params.assertOwned();
      if (entries.size >= 1_000_000) {
        throw new Error("Candidate recovery inventory exceeds one million entries.");
      }
      const before = await statOrMissing(pathname);
      const original = baseline.get(pathname);
      if (!before) {
        entries.set(pathname, {
          kind: "missing",
          sourcePath: pathname,
          sqlite: (original?.kind === "file" || original?.kind === "missing") && original.sqlite,
          directory:
            original?.kind === "directory" || (original?.kind === "missing" && original.directory),
        });
        return;
      }
      if (before.isDirectory()) {
        const source = await pinDirectory(pathname);
        if (source.receipt.realPath !== pathname) {
          await source.close();
          throw new Error(`Candidate recovery directory changed location: ${pathname}`);
        }
        entries.set(pathname, {
          kind: "directory",
          sourcePath: pathname,
          mode: before.mode & 0o777,
        });
        try {
          for (const child of (await fs.readdir(pathname)).toSorted()) {
            await source.assertCurrent();
            await copy(path.join(pathname, child));
          }
          await source.assertCurrent();
        } finally {
          await source.close();
        }
        return;
      }
      if (before.isSymbolicLink()) {
        entries.set(pathname, {
          kind: "symlink",
          sourcePath: pathname,
          target: await fs.readlink(pathname),
          ...(original?.kind === "symlink" && original.contentPath
            ? { contentPath: original.contentPath }
            : {}),
        });
        return;
      }
      if (!before.isFile()) {
        throw new Error(`Cannot preserve candidate recovery resource: ${pathname}`);
      }
      const rawFile =
        original?.kind === "file"
          ? !original.sqlite
          : original?.kind === "missing" && !original.sqlite && !original.directory;
      const suffix = SQLITE_SIDECAR_SUFFIXES.find((value) => pathname.endsWith(value));
      if (suffix && !rawFile) {
        const databasePath = pathname.slice(0, -suffix.length);
        if (
          (await statOrMissing(databasePath))?.isFile() &&
          (await isSqliteSnapshotFile(databasePath, { requireHeader: true }))
        ) {
          return;
        }
      }
      const sqlite = !rawFile && (await isSqliteSnapshotFile(pathname, { requireHeader: true }));
      const archivePath = `payload/${entries.size}`;
      const targetPath = path.join(directory, archivePath);
      if (sqlite) {
        await createVerifiedSqliteSnapshot({
          sourcePath: pathname,
          targetPath,
          preserveRowIds: true,
          sourceStagingRoot: directory,
          beforePublish: params.assertOwned,
        });
      } else {
        const source = await (
          await safeRoot(path.dirname(pathname))
        ).open(path.basename(pathname), { symlinks: "reject", hardlinks: "allow" });
        const output = await fs.open(targetPath, "wx+", 0o600);
        try {
          const opened = await source.handle.stat({ bigint: true });
          if (before.dev !== source.stat.dev || before.ino !== source.stat.ino) {
            throw new Error(`Candidate recovery resource changed before preservation: ${pathname}`);
          }
          await copyFileHandle(source.handle, output, {
            noProgressMessage: "Candidate recovery copy made no progress.",
          });
          if (!sameFileMutationFingerprint(opened, await source.handle.stat({ bigint: true }))) {
            throw new Error(`Candidate recovery resource changed during preservation: ${pathname}`);
          }
          await output.sync();
        } finally {
          await output.close();
          await source.handle.close();
        }
      }
      entries.set(pathname, {
        kind: "file",
        sourcePath: pathname,
        archivePath,
        ...(await fileDigest(targetPath)),
        sqlite,
        mode: before.mode & 0o777,
      });
    };
    for (const root of manifest.roots) {
      await copy(root);
    }
    // A missing database can have new crash-recovery sidecars even when the main file is damaged.
    for (const entry of manifest.entries) {
      if (
        (entry.kind === "file" || entry.kind === "missing") &&
        entry.sqlite &&
        entries.get(entry.sourcePath)?.kind !== "symlink"
      ) {
        const source = entries.get(entry.sourcePath);
        if (source?.kind === "file" && source.sqlite) {
          continue;
        }
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          const sidecar = `${entry.sourcePath}${suffix}`;
          if (await statOrMissing(sidecar)) {
            await copy(sidecar);
          }
        }
      }
    }
    const captured = [...entries.values()];
    const candidate: UpdateRecoveryBackupManifest = {
      ...manifest,
      createdAt: new Date().toISOString(),
      entries: captured,
      excludedRoots,
      roots: [
        ...new Set([
          ...manifest.roots,
          ...captured
            .filter((entry) => !manifest.roots.some((root) => within(entry.sourcePath, root)))
            .map((entry) => entry.sourcePath),
        ]),
      ],
    };
    const raw = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) {
      throw new Error("Candidate recovery inventory exceeds its manifest size bound.");
    }
    parseUpdateRecoveryBackupManifest(raw);
    const output = await fs.open(path.join(directory, "manifest.json"), "wx", 0o600);
    try {
      await output.writeFile(raw);
      await output.sync();
    } finally {
      await output.close();
    }
    requireDirectorySync(
      await syncDirectory(path.join(directory, "payload")),
      "Candidate recovery payload",
    );
    requireDirectorySync(await pin.sync(), "Candidate recovery capture");
    requireDirectorySync(await syncDirectory(params.directory), "Candidate recovery root");
    await params.assertCurrent();
    params.assertOwned();
    const warnings: UpdateRecoveryRestoreWarning[] = [];
    for (const pathname of new Set([...baseline.keys(), ...entries.keys()])) {
      const before = baseline.get(pathname);
      const current = entries.get(pathname);
      const unchanged =
        before?.kind === "file" && current?.kind === "file"
          ? before.sha256 === current.sha256 && before.mode === current.mode
          : isDeepStrictEqual(before, current);
      if (unchanged || (!before && current?.kind === "missing")) {
        continue;
      }
      const resource = current?.kind === "missing" ? before : (current ?? before);
      if (!resource || resource.kind === "missing") {
        continue;
      }
      warnings.push({
        kind: "discarded-post-capture-writes",
        sourcePath: pathname,
        resourceKind:
          resource.kind === "file" &&
          (resource.sqlite ||
            ((before?.kind === "file" || before?.kind === "missing") && before.sqlite))
            ? "sqlite"
            : resource.kind,
      });
    }
    for (const entry of manifest.entries) {
      if (
        entry.kind === "directory" &&
        warnings.some(
          (warning) =>
            warning.sourcePath !== entry.sourcePath && within(warning.sourcePath, entry.sourcePath),
        ) &&
        !warnings.some((warning) => warning.sourcePath === entry.sourcePath)
      ) {
        warnings.push({
          kind: "discarded-post-capture-writes",
          sourcePath: entry.sourcePath,
          resourceKind: "directory",
        });
      }
    }
    prepared = true;
    return {
      directory,
      warnings,
      retire: async () => {
        await params.assertCurrent();
        await pin.assertCurrent();
        params.assertOwned();
        await fs.rm(directory, { recursive: true });
        requireDirectorySync(
          await syncDirectory(params.directory),
          "Candidate recovery retirement",
        );
      },
      close: () => pin.close(),
    };
  } catch (cause) {
    throw new Error(
      `Candidate preservation failed before restoration; live state is unchanged. Baseline: ${path.join(params.directory, "manifest.json")}; incomplete candidate: ${directory}. Inspect the retained artifacts before manual recovery; automatic retry is refused.`,
      { cause },
    );
  } finally {
    if (!prepared) {
      await pin.close();
    }
  }
}
