import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertUpdateRecoveryCapacity } from "./update-recovery-capacity.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([3, 5])(
  "reserves WAL-complete candidate retention and publication scratch before mutation (%i GiB free)",
  async (freeGiB) => {
    const root = directories.make("update-recovery-capacity-");
    const databasePath = path.join(root, "state.sqlite");
    const filePath = path.join(root, "migration-input");
    const directory = path.join(root, "captures", "transaction");
    const mib = 1024 * 1024;
    for (const [pathname, bytes] of [
      [databasePath, 128 * mib],
      [`${databasePath}-wal`, 64 * mib],
      [filePath, 64 * mib],
    ] as const) {
      await fs.writeFile(pathname, "fixture");
      await fs.truncate(pathname, bytes);
    }
    const capacity = fsSync.statfsSync(root);
    vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      ...capacity,
      bsize: 1,
      bavail: freeGiB * 1024 * mib,
      blocks: 8 * 1024 * mib,
    });
    const before = await fs.readdir(root);
    const admission = assertUpdateRecoveryCapacity({
      directory,
      files: [
        { pathname: databasePath, size: 128 * mib, sqlite: true },
        { pathname: filePath, size: 64 * mib, sqlite: false },
      ],
    });
    if (freeGiB === 3) {
      await expect(admission).rejects.toThrow(
        /Insufficient update recovery capacity.*candidate preservation/,
      );
    } else {
      await expect(admission).resolves.toBeUndefined();
    }
    expect(await fs.readdir(root)).toEqual(before);
    expect((await fs.stat(`${databasePath}-wal`)).size).toBe(64 * mib);
  },
);
