import { writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readConfigGetResponse } from "../config-get-response.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

vi.mock("../config-get-response.js", () => ({
  readConfigGetResponse: vi.fn(),
  invalidateConfigGetResponseCache: vi.fn(),
}));
const dirs = createTempDirTracker();
afterEach(dirs.cleanup);

it.each([
  { exists: false, valid: true, backup: true, recovery: true },
  { exists: true, valid: false, backup: true, recovery: true },
  { exists: false, valid: true, backup: false, recovery: false },
  { exists: true, valid: false, backup: false, recovery: false },
  { exists: true, valid: true, backup: true, recovery: false },
])(
  "config.get preserves recovery for every reader: %j",
  async ({ exists, valid, backup, recovery }) => {
    const configPath = path.join(dirs.make("config-read-recovery-"), "openclaw.json");
    const recoveryBackupPath = `${configPath}.bak`;
    if (backup) {
      writeFileSync(recoveryBackupPath, '{"gateway":{"mode":"local"}}');
    }
    const snapshot = {
      ...createConfigWriteSnapshot({}).snapshot,
      path: configPath,
      exists,
      valid,
      configRevisionHash: "revision",
      appliedConfigHash: null,
    };
    vi.mocked(readConfigGetResponse).mockResolvedValue(snapshot);
    const { options, respond } = createConfigHandlerHarness({ method: "config.get" });
    await expectDefined(configHandlers["config.get"], "registered config.get")(options);
    if (recovery) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          details: { configPath, recoveryBackupPath, rollbackStatus: "unknown" },
        }),
      );
    } else {
      expect(respond).toHaveBeenCalledWith(true, snapshot, undefined);
    }
  },
);
