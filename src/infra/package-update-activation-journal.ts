import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import {
  PACKAGE_ACTIVATION_JOURNAL,
  assertPrivatePackageActivationFile,
  encodePackageActivationDescriptor,
  encodePackageActivationIntent,
  assertPackageActivationPhase,
  readPackageActivationRecord,
  packageActivationIdentity,
  type PackageActivationDescriptor,
  type PackageActivationPhase,
  type PackageActivationIntent,
  type PackageActivationRecord,
  type ActivationRow,
} from "./package-update-activation-record.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
// Preserve the existing journal data-contract imports while sharing one decoder.
export {
  PACKAGE_ACTIVATION_JOURNAL,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  type PackageActivationDescriptor,
  type PackageActivationPhase,
  type PackageActivationIntent,
  type PackageActivationRecord,
} from "./package-update-activation-record.js";
const queries = (db: DatabaseSync) =>
  getNodeSqliteKysely<{ package_activation: ActivationRow }>(db);

/** An existing operation is never bootstrapped, migrated, or repaired on open. */
export function openPackageActivationJournal(anchor: string) {
  const journalPath = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
  const anchorIdentity = assertPrivatePackageActivationFile(anchor, true);
  const journalIdentity = assertPrivatePackageActivationFile(journalPath, false);
  const assertFiles = () => {
    if (
      assertPrivatePackageActivationFile(anchor, true) !== anchorIdentity ||
      assertPrivatePackageActivationFile(journalPath, false) !== journalIdentity ||
      fs.realpathSync(anchor) !== anchor
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  const withDatabase = <T>(
    write: boolean,
    operation: (db: DatabaseSync, transact: ExistingSqliteTransaction) => T,
  ): T =>
    withExistingSqliteRollbackDatabase(
      journalPath,
      {
        write,
        busyTimeoutMs: 0,
        assertIdentity: assertFiles,
        validate: (db) => {
          executeSqliteQuerySync(
            db,
            queries(db).selectFrom("package_activation").selectAll().limit(0),
          );
        },
      },
      operation,
    );
  const readRecord = (db: DatabaseSync) =>
    readPackageActivationRecord(db, {
      anchor,
      anchorIdentity,
      journalIdentity,
      store: { kind: "sibling" },
    });
  const read = () => withDatabase(false, (db) => readRecord(db));
  const assertRecord = (expected: PackageActivationRecord, actual: PackageActivationRecord) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Package publication intent is no longer current");
    }
  };
  return {
    read,
    assertCurrent(expected: PackageActivationRecord) {
      assertRecord(expected, read());
    },
    transition(
      expected: PackageActivationRecord,
      phase: PackageActivationPhase,
      intent: PackageActivationIntent,
      assertCurrent: () => void,
      publications = expected.publications,
    ): PackageActivationRecord {
      const intentJson = encodePackageActivationIntent(intent);
      assertPackageActivationPhase(phase);
      return withDatabase(true, (db, transact) => {
        assertCurrent();
        return transact(
          () => {
            assertFiles();
            assertCurrent();
            assertRecord(expected, readRecord(db));
            executeSqliteQuerySync(
              db,
              queries(db)
                .updateTable("package_activation")
                .set({
                  revision: expected.revision + 1,
                  phase,
                  intent_json: intentJson,
                  publications_json: JSON.stringify(publications),
                })
                .where("slot", "=", 1)
                .where("revision", "=", expected.revision),
            );
            return readRecord(db);
          },
          {
            withCommit: (commit) => {
              assertFiles();
              assertCurrent();
              commit();
            },
          },
        );
      });
    },
  };
}
export type PackageActivationJournal = ReturnType<typeof openPackageActivationJournal>;

/** Only the original admitted producer may create the one-operation database. */
export function createPackageActivationJournal(
  anchor: string,
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  assertCurrent: () => void,
): PackageActivationJournal {
  const assertAnchor = () => {
    assertCurrent();
    if (
      assertPrivatePackageActivationFile(anchor, true) !== descriptor.anchorIdentity ||
      packageActivationIdentity(path.dirname(anchor), true) !== descriptor.parentIdentity ||
      fs.realpathSync(anchor) !== anchor
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  assertAnchor();
  encodePackageActivationDescriptor({ ...descriptor, journalIdentity: "0:0" });
  const journalPath = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
  const fd = fs.openSync(journalPath, "wx", 0o600);
  try {
    // Keep the created inode live until all SQLite connections are closed. A
    // later pathname observation must never become the creation authority.
    const created = fs.fstatSync(fd, { bigint: true });
    const journalIdentity = `${created.dev}:${created.ino}`;
    const assertCreated = () => {
      assertAnchor();
      if (assertPrivatePackageActivationFile(journalPath, false) !== journalIdentity) {
        throw new Error("Package publication journal identity changed");
      }
    };
    assertCreated();
    const encoded = encodePackageActivationDescriptor({ ...descriptor, journalIdentity });
    const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(journalPath));
    try {
      assertCreated();
      executeSqliteQuerySync(
        db,
        queries(db)
          .schema.createTable("package_activation")
          .addColumn("slot", "integer", (column) => column.primaryKey().notNull())
          .addColumn("revision", "integer", (column) => column.notNull())
          .addColumn("phase", "text", (column) => column.notNull())
          .addColumn("descriptor_json", "text", (column) => column.notNull())
          .addColumn("intent_json", "text", (column) => column.notNull())
          .addColumn("publications_json", "text", (column) => column.notNull())
          .modifyEnd(sql`STRICT`),
      );
      assertCreated();
      executeSqliteQuerySync(
        db,
        queries(db).insertInto("package_activation").values({
          slot: 1,
          revision: 0,
          phase: "prepared",
          descriptor_json: encoded,
          intent_json: "null",
          publications_json: "[]",
        }),
      );
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
    assertCreated();
    return openPackageActivationJournal(anchor);
  } finally {
    fs.closeSync(fd);
  }
}
