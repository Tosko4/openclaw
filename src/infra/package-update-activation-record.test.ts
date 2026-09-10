import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  packageActivationIdentity,
  readPackageActivationRecord,
  resolvePackageActivationAnchor,
  type PackageActivationDescriptor,
  type PackageActivationRecordBinding,
} from "./package-update-activation-record.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";

afterEach(() => vi.restoreAllMocks());
const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = fs.realpathSync(dirs.make("activation-scoped-record-"));
  fs.chmodSync(root, 0o700);
  const databasePath = path.join(root, "managed-update-handoffs.sqlite");
  fs.writeFileSync(databasePath, "", { mode: 0o600 });
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE package_activation_operations (
    install_key TEXT, slot INTEGER, revision INTEGER, phase TEXT,
    descriptor_json, intent_json, publications_json
  )`);
  const bind = (name: string, target?: string) => {
    const installKey = path.join(root, name);
    if (target) {
      fs.symlinkSync(target, installKey);
    } else {
      fs.mkdirSync(installKey, { mode: 0o700 });
    }
    const anchor = resolvePackageActivationAnchor(installKey);
    fs.mkdirSync(anchor, { mode: 0o700 });
    const authority = {
      databasePath,
      databaseIdentity: packageActivationIdentity(databasePath, false),
      parentIdentity: packageActivationIdentity(root, true),
      installKey,
      owner: randomUUID(),
    };
    const descriptor: PackageActivationDescriptor = {
      version: 1,
      operationId: randomUUID(),
      authority,
      anchorIdentity: packageActivationIdentity(anchor, true),
      journalIdentity: authority.databaseIdentity,
      parentIdentity: authority.parentIdentity,
      binDir: root,
      binIdentity: authority.parentIdentity,
      originalStageRoot: path.join(root, `stage-${name}`),
      previous: { digest: "a".repeat(64), identity: "1:2", version: "1" },
      candidate: { digest: "b".repeat(64), identity: "1:3", version: "2" },
      launcherRootIdentity: "1:4",
      previousLauncherRootIdentity: null,
      helperDigest: "c".repeat(64),
      launchers: [
        {
          name: "openclaw",
          previous: null,
          candidate: "candidate",
          previousIdentity: null,
          candidateIdentity: "1:5",
        },
      ],
    };
    const binding: PackageActivationRecordBinding = {
      anchor,
      anchorIdentity: descriptor.anchorIdentity,
      journalIdentity: descriptor.journalIdentity,
      store: { kind: "authority", identity: authority },
    };
    db.prepare(
      "INSERT INTO package_activation_operations VALUES (?,1,0,'retired',?,'null','[]')",
    ).run(installKey, JSON.stringify(descriptor));
    return { installKey, descriptor, binding };
  };
  const first = bind("a");
  const second = bind("b");
  const read = (binding: PackageActivationRecordBinding) => {
    db.exec("BEGIN");
    try {
      return readPackageActivationRecord(db, binding);
    } finally {
      db.exec("ROLLBACK");
    }
  };
  return { root, databasePath, db, first, second, read, bind };
}

describe("full scoped package activation records", () => {
  it("isolates full records for two installations without reading malformed peer JSON", () => {
    const f = fixture();
    try {
      expect(f.read(f.first.binding).descriptor).toEqual(f.first.descriptor);
      expect(f.read(f.second.binding).descriptor).toEqual(f.second.descriptor);
      f.db
        .prepare(
          "UPDATE package_activation_operations SET descriptor_json = '{' WHERE install_key = ?",
        )
        .run(f.second.installKey);
      expect(f.read(f.first.binding).descriptor).toEqual(f.first.descriptor);
      expect(() => f.read(f.second.binding)).toThrow();
    } finally {
      f.db.close();
    }
  });

  it.each([
    "missing",
    "duplicate",
    "wrong-install",
    "wrong-store",
    "unknown-field",
    "unknown-launcher",
    "blob",
    "oversize",
  ])("refuses %s in the selected scope and leaves its peer untouched", (kind) => {
    const f = fixture();
    try {
      const peer = f.read(f.second.binding);
      if (kind === "missing") {
        f.db
          .prepare("DELETE FROM package_activation_operations WHERE install_key = ?")
          .run(f.first.installKey);
      } else if (kind === "duplicate") {
        f.db
          .prepare(
            "INSERT INTO package_activation_operations SELECT * FROM package_activation_operations WHERE install_key = ?",
          )
          .run(f.first.installKey);
      } else if (kind === "blob") {
        f.db
          .prepare("UPDATE package_activation_operations SET intent_json = ? WHERE install_key = ?")
          .run(Buffer.from("null"), f.first.installKey);
      } else if (kind === "oversize") {
        f.db
          .prepare(
            "UPDATE package_activation_operations SET publications_json = ? WHERE install_key = ?",
          )
          .run(" ".repeat(1048577), f.first.installKey);
      } else if (kind === "unknown-launcher") {
        f.db
          .prepare("UPDATE package_activation_operations SET intent_json = ? WHERE install_key = ?")
          .run(
            JSON.stringify({ kind: "launcher", name: "foreign", identity: "1:5" }),
            f.first.installKey,
          );
      } else {
        const descriptor =
          kind === "wrong-install"
            ? f.second.descriptor
            : kind === "wrong-store"
              ? {
                  ...f.first.descriptor,
                  authority: { ...f.first.descriptor.authority, databaseIdentity: "9:9" },
                }
              : { ...f.first.descriptor, unexpected: true };
        f.db
          .prepare(
            "UPDATE package_activation_operations SET descriptor_json = ? WHERE install_key = ?",
          )
          .run(JSON.stringify(descriptor), f.first.installKey);
      }
      const before = fs.readFileSync(f.databasePath);
      expect(() => f.read(f.first.binding)).toThrow();
      expect(f.read(f.second.binding)).toEqual(peer);
      expect(fs.readFileSync(f.databasePath)).toEqual(before);
    } finally {
      f.db.close();
    }
  });

  it("requires an owned snapshot and the original connection, not copied descriptor identities", () => {
    const f = fixture();
    try {
      expect(() => readPackageActivationRecord(f.db, f.first.binding)).toThrow(/snapshot/);
      const copyPath = path.join(f.root, "copy.sqlite");
      fs.copyFileSync(f.databasePath, copyPath);
      const copy = new DatabaseSync(copyPath);
      try {
        copy.exec("BEGIN");
        expect(() => readPackageActivationRecord(copy, f.first.binding)).toThrow(/scope/);
      } finally {
        copy.close();
      }
    } finally {
      f.db.close();
    }
  });
});

describe("original executor scoped terminal settlement", () => {
  it("settles only its complete record and paired A/S leases, retaining another installation", async () => {
    const f = fixture();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    const slot = path.join(f.root, "slot");
    fs.symlinkSync(f.first.installKey, slot);
    try {
      const peer = f.read(f.second.binding);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(slot);
        const expected = f.read(f.first.binding);
        executor.requestPackageSettlement(fence, expected);
        expected.revision = 100; // The registered request owns its complete copy.
      });
      expect(() => f.read(f.first.binding)).toThrow();
      expect(f.read(f.second.binding)).toEqual(peer);
      expect(f.db.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it("does not authorize the historical record owner after the live original lease changes", async () => {
    const f = fixture();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    try {
      const record = f.read(f.first.binding);
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.first.installKey);
          expect(captureUpdateCommandExecutorAuthority(fence).owner).not.toBe(
            record.descriptor.authority.owner,
          );
          executor.requestPackageSettlement(fence, record);
          f.db
            .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
            .run(record.descriptor.authority.owner, f.first.installKey);
        }),
      ).rejects.toThrow();
      expect(f.read(f.first.binding)).toEqual(record);
      expect(
        f.db
          .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root = ?")
          .get(f.first.installKey)?.owner,
      ).toBe(record.descriptor.authority.owner);
    } finally {
      f.db.close();
    }
  });

  it("cannot select a complete occupied-slot journal instead of its captured original domain", async () => {
    const f = fixture();
    const slot = f.bind("slot", f.first.installKey);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    try {
      const slotRecord = f.read(slot.binding);
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(slot.installKey);
        expect(captureUpdateCommandExecutorAuthority(fence).installKey).toBe(f.first.installKey);
        expect(() => executor.requestPackageSettlement(fence, slotRecord)).toThrow();
        executor.requestPackageSettlement(fence, f.read(f.first.binding));
      });
      expect(() => f.read(f.first.binding)).toThrow();
      expect(f.read(slot.binding)).toEqual(slotRecord);
      expect(f.db.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it.each([false, true])(
    "rolls back journal deletion when the %s paired lease delete refuses",
    async (paired) => {
      const f = fixture();
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
      const slot = path.join(f.root, "slot");
      fs.symlinkSync(f.first.installKey, slot);
      try {
        const original = f.read(f.first.binding);
        const refusedKey = paired ? slot : f.first.installKey;
        // A real SQLite conditional refusal, after the journal DELETE. No runtime test hook.
        f.db.exec(`CREATE TRIGGER refuse_release BEFORE DELETE ON managed_update_handoffs
        WHEN OLD.install_root = '${refusedKey.replaceAll("'", "''")}' BEGIN SELECT RAISE(IGNORE); END;`);
        await expect(
          withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(paired ? slot : f.first.installKey);
            executor.requestPackageSettlement(fence, original);
          }),
        ).rejects.toThrow();
        expect(f.read(f.first.binding)).toEqual(original);
        expect(f.db.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(
          paired ? 2 : 1,
        );
        expect(f.read(f.second.binding).descriptor).toEqual(f.second.descriptor);
      } finally {
        f.db.close();
      }
    },
  );

  it("rereads scoped revision inside release rather than trusting request-time facts", async () => {
    const f = fixture();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    try {
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.first.installKey);
          executor.requestPackageSettlement(fence, f.read(f.first.binding));
          f.db
            .prepare("UPDATE package_activation_operations SET revision = 1 WHERE install_key = ?")
            .run(f.first.installKey);
        }),
      ).rejects.toThrow();
      expect(f.read(f.first.binding).revision).toBe(1);
      expect(f.db.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("closes terminal registration with the original invocation", async () => {
    const f = fixture();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    try {
      const saved = await withUpdateCommandExecutor(randomUUID(), async (executor) => ({
        executor,
        fence: await executor.enter(f.first.installKey),
      }));
      const before = f.read(f.first.binding);
      expect(() => saved.executor.requestPackageSettlement(saved.fence, before)).toThrow(
        /no longer current/,
      );
      expect(f.read(f.first.binding)).toEqual(before);
      expect(f.db.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it("does not accept an unregistered fence or an operation for the other installation", async () => {
    const f = fixture();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(f.root);
    try {
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.first.installKey);
        expect(() =>
          executor.requestPackageSettlement(
            { assertCurrent: fence.assertCurrent },
            f.read(f.first.binding),
          ),
        ).toThrow(/original direct owner/);
        expect(() => executor.requestPackageSettlement(fence, f.read(f.second.binding))).toThrow();
      });
      expect(f.read(f.first.binding).descriptor).toEqual(f.first.descriptor);
      expect(f.read(f.second.binding).descriptor).toEqual(f.second.descriptor);
    } finally {
      f.db.close();
    }
  });
});
