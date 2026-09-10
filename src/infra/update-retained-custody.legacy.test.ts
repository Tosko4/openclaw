import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../config/write-lock.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import {
  seedRetainedBorrower,
  type RetainedBorrowerSource,
} from "./update-retained-custody.test-support.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

let configPath: string;
let databasePath: string;
let store: ReturnType<typeof createManagedHandoffLeaseStore>;

beforeEach(() => {
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retained-legacy-")));
  fs.chmodSync(fixture.root, 0o700);
  configPath = path.join(fixture.root, "openclaw.json");
  databasePath = path.join(fixture.root, "managed-update-handoffs.sqlite");
  store = createManagedHandoffLeaseStore();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function acquire(name = "install") {
  const root = path.join(fixture.root, name);
  fs.mkdirSync(root);
  const result = store.acquire(root, "legacy-owner", { kind: "update" });
  if (result.kind !== "acquired") {
    throw new Error("fixture busy");
  }
  return result.lease;
}
function rewritePayload(lease: ManagedHandoffLease, payload: unknown) {
  const db = new DatabaseSync(databasePath);
  try {
    expect(
      db
        .prepare("UPDATE managed_update_handoffs SET payload_json = ? WHERE install_root = ?")
        .run(JSON.stringify(payload), lease.key).changes,
    ).toBe(1);
  } finally {
    db.close();
  }
}
function borrowerSource(overrides: Partial<RetainedBorrowerSource> = {}) {
  return {
    runId: "run",
    transactionId: "transaction",
    claimId: "claim",
    revision: 1,
    recordSha256: "a".repeat(64),
    lifetimeId: "lifetime",
    serviceKey: path.join(fixture.root, "unrelated-service"),
    configPaths: [configPath],
    ...overrides,
  };
}
function writeConfig() {
  const callback = vi.fn(async () => {
    fs.writeFileSync(configPath, "{}");
  });
  return { callback, done: withConfigWriteLock(configPath, callback, {}) };
}

// A retired v1 claim records no borrower source, so it never reserved a config
// path. Refusing every config write while one survives stranded whole installs.
it("admits ordinary config writers alongside a retired v1 claim", async () => {
  const legacy = acquire();
  rewritePayload(legacy, { version: 1, pid: process.pid, startIdentity: "0" });

  const { callback, done } = writeConfig();
  await expect(done).resolves.toBeUndefined();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}");
  expect(store.read(legacy.key)).toEqual({ kind: "unreadable" });
});

it("refuses config writers while an unreadable lease shape is retained", async () => {
  const damaged = acquire();
  // Complete v1 plus authority it never carried: prospective, not retired.
  rewritePayload(damaged, {
    version: 1,
    pid: process.pid,
    startIdentity: "0",
    action: { kind: "update" },
  });

  const { callback, done } = writeConfig();
  await expect(done).rejects.toThrow("incompatible");
  expect(callback).not.toHaveBeenCalled();
  expect(fs.existsSync(configPath)).toBe(false);
});

it("keeps refusing config writers that a retained borrower reserved", async () => {
  const retained = acquire("retained");
  seedRetainedBorrower(databasePath, retained, borrowerSource(), "admitted");
  rewritePayload(acquire("released"), { version: 1, pid: process.pid, startIdentity: "0" });

  const { callback, done } = writeConfig();
  await expect(done).rejects.toThrow("native custody");
  expect(callback).not.toHaveBeenCalled();
  expect(fs.existsSync(configPath)).toBe(false);
});
