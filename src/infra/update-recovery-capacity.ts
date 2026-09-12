import fs from "node:fs/promises";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";

const RESERVE_BYTES = 1024 * 1024 * 1024;

type CaptureFile = { pathname: string; size: number; sqlite: boolean };

/** Account only for declared capture inputs and their recovery copies, per volume. */
export async function assertUpdateRecoveryCapacity(params: {
  directory: string;
  files: readonly CaptureFile[];
}): Promise<void> {
  const volumes = new Map<number, { pathname: string; required: number; available: number }>();
  const add = async (pathname: string, bytes: number) => {
    const capacity = tryReadDiskSpace(pathname);
    if (!capacity) {
      throw new Error(
        `Cannot determine update recovery capacity for ${pathname}; protected mutation refused. Live data and earlier captures are unchanged. Inspect openclaw update status --json before retrying.`,
      );
    }
    const device = (await fs.stat(capacity.checkedPath)).dev;
    const volume = volumes.get(device) ?? {
      pathname: capacity.checkedPath,
      required: RESERVE_BYTES,
      available: capacity.availableBytes,
    };
    volume.required += bytes;
    volume.available = Math.min(volume.available, capacity.availableBytes);
    if (!Number.isSafeInteger(volume.required) || !Number.isSafeInteger(volume.available)) {
      throw new Error(`Cannot safely account for update recovery capacity on ${volume.pathname}.`);
    }
    volumes.set(device, volume);
  };
  let captureBytes = MAX_MANIFEST_BYTES;
  let largestInputBytes = 0;
  for (const file of params.files) {
    let bytes = file.size;
    if (file.sqlite) {
      // WAL pages can grow the online snapshot beyond the main file's current size.
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        bytes += (await statOrMissing(`${file.pathname}${suffix}`))?.size ?? 0;
      }
    }
    captureBytes += bytes;
    largestInputBytes = Math.max(largestInputBytes, bytes);
    await add(file.pathname, bytes * 3); // 100% migration growth plus publication stage and fallback copy.
  }
  // Baseline + verification + a candidate at 100% growth. Snapshot/crash-recovery scratch is per file.
  await add(params.directory, captureBytes * 4 + largestInputBytes * 4);
  for (const volume of volumes.values()) {
    if (volume.available < volume.required) {
      throw new Error(
        `Insufficient update recovery capacity on ${volume.pathname}: ${formatDiskSpaceBytes(volume.required)} required (${volume.required} bytes), ${formatDiskSpaceBytes(volume.available)} available (${volume.available} bytes), including capture, verification/restore staging, candidate preservation, growth, and reserve. Protected mutation refused; live data and earlier captures are unchanged. Free unrelated space, then retry; inspect openclaw update status --json.`,
      );
    }
  }
}
