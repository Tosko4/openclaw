import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";

const PACKAGE_ACTIVATION_JOURNAL = "operation.sqlite";
const MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES = 1024 * 1024;
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.resolve(value) === value);
const identity = z.string().regex(/^\d+:\d+$/u);
const fingerprint = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  identity,
  version: z.string().min(1).max(256),
});
const basename = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== ".." && !/[\\/\0]/u.test(value));
const transferName = z.enum(["anchor", "helper", "candidate", "launchers", "previous-launchers"]);
const PackageActivationDescriptorSchema = z.strictObject({
  layout: z.literal("external-helper"),
  version: z.literal(1),
  operationId: z.uuid(),
  authority: z.strictObject({
    databasePath: absolutePath,
    databaseIdentity: identity,
    parentIdentity: identity,
    installKey: absolutePath,
    owner: z.string().min(1).max(4096),
  }),
  anchorIdentity: identity,
  journalIdentity: identity,
  parentIdentity: identity,
  binDir: absolutePath,
  binIdentity: identity,
  originalStageRoot: absolutePath,
  previous: fingerprint,
  candidate: fingerprint,
  launcherRootIdentity: identity,
  previousLauncherRootIdentity: identity.nullable(),
  helperIdentity: identity,
  preparation: z
    .array(
      z.strictObject({
        name: transferName,
        source: absolutePath,
        sourceParentIdentity: identity,
        identity,
      }),
    )
    .min(4)
    .max(5),
  helperDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  launchers: z
    .array(
      z.strictObject({
        name: basename,
        previous: z.string().max(4096).nullable(),
        candidate: z.string().max(4096),
        previousIdentity: identity.nullable(),
        candidateIdentity: identity,
      }),
    )
    .max(64),
});
export type PackageActivationDescriptor = z.infer<typeof PackageActivationDescriptorSchema>;
const PackageActivationPhaseSchema = z.enum([
  "preparing",
  "prepared",
  "publishing",
  "publication-complete",
  "rollback-in-progress",
  "rolled-back",
  "aborted",
  "retiring",
  "retired",
  "anchor-retired",
]);
export type PackageActivationPhase = z.infer<typeof PackageActivationPhaseSchema>;
const intentSchema = z
  .union([
    z.strictObject({
      kind: z.literal("prepare"),
      completed: z.array(transferName).max(5),
      moving: transferName.nullable(),
    }),
    z.strictObject({
      kind: z.enum(["remove-anchor", "unlink-helper"]),
      identity,
      selected: z.enum(["previous", "candidate"]),
    }),
    z.strictObject({ kind: z.enum(["displace", "publish"]) }),
    z.strictObject({ kind: z.literal("launcher"), name: basename, identity }),
    z.strictObject({ kind: z.literal("retire"), selected: z.enum(["previous", "candidate"]) }),
    z.strictObject({
      kind: z.literal("remove"),
      name: z.enum([
        "previous",
        "candidate",
        "previous.candidate",
        "launchers",
        "previous-launchers",
      ]),
      identity,
      selected: z.enum(["previous", "candidate"]),
    }),
  ])
  .nullable();
export type PackageActivationIntent = z.infer<typeof intentSchema>;
export type PackageActivationRecord = {
  revision: number;
  phase: PackageActivationPhase;
  intent: PackageActivationIntent;
  descriptor: PackageActivationDescriptor;
  publications: Array<{ name: string; identity: string }>;
};
type ActivationRow = {
  slot: number;
  revision: number;
  phase: string;
  descriptor_json: string;
  intent_json: string;
  publications_json: string;
};
const queries = (db: DatabaseSync) =>
  getNodeSqliteKysely<{ package_activation: ActivationRow }>(db);

export function packageActivationIdentity(file: string, directory: boolean | "launcher"): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    stat.ino === 0n ||
    !(directory === "launcher"
      ? stat.isSymbolicLink() || stat.isFile()
      : directory
        ? stat.isDirectory() && !stat.isSymbolicLink()
        : stat.isFile()) ||
    (process.getuid && stat.uid !== BigInt(process.getuid()))
  ) {
    throw new Error("Package publication object has an unsafe identity");
  }
  return `${stat.dev}:${stat.ino}`;
}

export function resolvePackageActivationAnchor(installKey: string): string {
  const key = createHash("sha256").update(installKey).digest("hex").slice(0, 24);
  return path.join(path.dirname(installKey), `.openclaw.package-activation-${key}`);
}

// Stable sibling paths survive removal of the disposable package anchor.
export function resolvePackageActivationJournalPath(anchor: string): string {
  return `${anchor}.sqlite`;
}
export function resolvePackageActivationHelper(anchor: string): string {
  return `${anchor}.recovery.mjs`;
}

/** A receipt is a read-only completion fact, never a grant for another effect. */
export function isPackageActivationComplete(
  anchor: string,
  record: PackageActivationRecord,
): boolean {
  if (record.phase !== "anchor-retired" || record.intent?.kind !== "unlink-helper") {
    return false;
  }
  if (record.intent.identity !== record.descriptor.helperIdentity) {
    throw new Error("Final helper unlink identity is invalid.");
  }
  for (const file of [anchor, resolvePackageActivationHelper(anchor)]) {
    try {
      fs.lstatSync(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return true;
}

function assertPrivate(file: string, directory: boolean): string {
  const value = packageActivationIdentity(file, directory);
  const stat = fs.lstatSync(file);
  if ((stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new Error("Package publication recovery permissions are unsafe");
  }
  return value;
}

function descriptorJson(descriptor: PackageActivationDescriptor): string {
  const encoded = JSON.stringify(PackageActivationDescriptorSchema.parse(descriptor));
  if (Buffer.byteLength(encoded) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES) {
    throw new Error("Package publication descriptor exceeds 1 MiB");
  }
  return encoded;
}

/** An existing operation is never bootstrapped, migrated, or repaired on open. */
export function openPackageActivationJournal(anchor: string) {
  if (fs.lstatSync(path.join(anchor, PACKAGE_ACTIVATION_JOURNAL), { throwIfNoEntry: false })) {
    throw new Error(
      "Legacy package activation artifacts require their original recovery owner; no migration is performed.",
    );
  }
  const journalPath = resolvePackageActivationJournalPath(anchor);
  const parent = path.dirname(anchor);
  const parentIdentity = packageActivationIdentity(parent, true);
  const journalIdentity = assertPrivate(journalPath, false);
  const assertFiles = () => {
    if (
      packageActivationIdentity(parent, true) !== parentIdentity ||
      assertPrivate(journalPath, false) !== journalIdentity ||
      fs.realpathSync(parent) !== parent
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
  const decode = (row: ActivationRow | undefined): PackageActivationRecord => {
    if (
      !row ||
      row.slot !== 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      Buffer.byteLength(row.descriptor_json) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES
    ) {
      throw new Error("Package publication journal is missing or invalid");
    }
    const descriptor = PackageActivationDescriptorSchema.parse(JSON.parse(row.descriptor_json));
    if (
      descriptor.parentIdentity !== parentIdentity ||
      descriptor.journalIdentity !== journalIdentity ||
      resolvePackageActivationAnchor(descriptor.authority.installKey) !== anchor ||
      descriptor.parentIdentity !== packageActivationIdentity(path.dirname(anchor), true) ||
      new Set(descriptor.launchers.map((entry) => entry.name)).size !== descriptor.launchers.length
    ) {
      throw new Error("Package publication journal does not match its installation");
    }
    const expectedTransfers = new Map<string, string>([
      ["anchor", descriptor.anchorIdentity],
      ["helper", descriptor.helperIdentity],
      ["candidate", descriptor.candidate.identity],
      ["launchers", descriptor.launcherRootIdentity],
    ]);
    if (descriptor.previousLauncherRootIdentity) {
      expectedTransfers.set("previous-launchers", descriptor.previousLauncherRootIdentity);
    }
    if (
      descriptor.preparation.length !== expectedTransfers.size ||
      new Set(descriptor.preparation.map((entry) => entry.name)).size !== expectedTransfers.size ||
      descriptor.preparation.some(
        (entry) => expectedTransfers.get(entry.name) !== entry.identity,
      ) ||
      descriptor.preparation.find((entry) => entry.name === "candidate")?.source !==
        descriptor.originalStageRoot
    ) {
      throw new Error("Preparation custody does not match the recorded objects.");
    }
    const publications = z
      .array(z.strictObject({ name: basename, identity }))
      .max(64)
      .parse(JSON.parse(row.publications_json));
    const intent = intentSchema.parse(JSON.parse(row.intent_json));
    const names = new Set(descriptor.launchers.map((entry) => entry.name));
    if (
      new Set(publications.map((entry) => entry.name)).size !== publications.length ||
      publications.some((entry) => !names.has(entry.name)) ||
      (intent?.kind === "launcher" && !names.has(intent.name))
    ) {
      throw new Error("Package publication intent names an unknown launcher.");
    }
    return {
      revision: row.revision,
      phase: PackageActivationPhaseSchema.parse(row.phase),
      intent,
      descriptor,
      publications,
    };
  };
  const readRow = (db: DatabaseSync) => {
    const sizes = executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("package_activation")
        .select((eb) => [
          "slot",
          eb.fn<number>("length", [eb.cast("descriptor_json", "blob")]).as("descriptor_bytes"),
          eb.fn<number>("length", [eb.cast("intent_json", "blob")]).as("intent_bytes"),
          eb.fn<number>("length", [eb.cast("publications_json", "blob")]).as("publications_bytes"),
        ])
        .limit(2),
    ).rows;
    const size = sizes[0];
    if (
      sizes.length !== 1 ||
      !size ||
      size.slot !== 1 ||
      [size.descriptor_bytes, size.intent_bytes, size.publications_bytes].some(
        (bytes) => bytes > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES,
      )
    ) {
      throw new Error("Package publication journal must contain one bounded operation.");
    }
    const rows = executeSqliteQuerySync(
      db,
      queries(db).selectFrom("package_activation").selectAll().limit(2),
    ).rows;
    if (rows.length !== 1) {
      throw new Error("Package publication journal must contain exactly one operation.");
    }
    return rows[0];
  };
  const read = () => withDatabase(false, (db) => decode(readRow(db)));
  const assertRecord = (expected: PackageActivationRecord, actual: PackageActivationRecord) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Package publication intent is no longer current");
    }
  };
  return {
    read,
    replaceCompleted(
      expected: PackageActivationRecord,
      descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
      assertCurrent: () => void,
    ) {
      const encoded = descriptorJson({ ...descriptor, journalIdentity });
      return withDatabase(true, (db, transact) =>
        transact(
          () => {
            assertFiles();
            assertCurrent();
            const previous = decode(readRow(db));
            assertRecord(expected, previous);
            if (
              !isPackageActivationComplete(anchor, previous) ||
              packageActivationIdentity(preparationSource(descriptor, "anchor"), true) !==
                descriptor.anchorIdentity ||
              packageActivationIdentity(preparationSource(descriptor, "helper"), false) !==
                descriptor.helperIdentity ||
              previous.descriptor.authority.databasePath !== descriptor.authority.databasePath ||
              previous.descriptor.authority.databaseIdentity !==
                descriptor.authority.databaseIdentity ||
              previous.descriptor.authority.parentIdentity !== descriptor.authority.parentIdentity
            ) {
              throw new Error("The previous package receipt is not safely replaceable.");
            }
            executeSqliteQuerySync(
              db,
              queries(db)
                .updateTable("package_activation")
                .set({
                  revision: previous.revision + 1,
                  phase: "preparing",
                  descriptor_json: encoded,
                  intent_json: JSON.stringify({ kind: "prepare", completed: [], moving: null }),
                  publications_json: "[]",
                })
                .where("slot", "=", 1)
                .where("revision", "=", previous.revision),
            );
          },
          {
            withCommit: (commit) => {
              assertFiles();
              assertCurrent();
              commit();
            },
          },
        ),
      );
    },
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
      const intentJson = JSON.stringify(intentSchema.parse(intent));
      PackageActivationPhaseSchema.parse(phase);
      return withDatabase(true, (db, transact) => {
        assertCurrent();
        return transact(
          () => {
            assertFiles();
            assertCurrent();
            assertRecord(expected, decode(readRow(db)));
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
            return decode(readRow(db));
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

function preparationSource(
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  name: "anchor" | "helper",
): string {
  const source = descriptor.preparation.find((entry) => entry.name === name)?.source;
  if (!source) {
    throw new Error("Package preparation bootstrap custody is missing.");
  }
  return source;
}

/** Only the original admitted producer may create the one-operation database. */
export function createPackageActivationJournal(
  anchor: string,
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  assertCurrent: () => void,
): PackageActivationJournal {
  const assertAnchor = () => {
    assertCurrent();
    if (
      assertPrivate(preparationSource(descriptor, "anchor"), true) !== descriptor.anchorIdentity ||
      packageActivationIdentity(path.dirname(anchor), true) !== descriptor.parentIdentity ||
      fs.realpathSync(path.dirname(anchor)) !== path.dirname(anchor) ||
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(resolvePackageActivationHelper(anchor), { throwIfNoEntry: false })
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  assertAnchor();
  descriptorJson({ ...descriptor, journalIdentity: "0:0" });
  const journalPath = resolvePackageActivationJournalPath(anchor);
  const fd = fs.openSync(journalPath, "wx", 0o600);
  try {
    // Retain the created inode until SQLite closes; a later pathname must not
    // become the authority for the file this producer created.
    const created = fs.fstatSync(fd, { bigint: true });
    const journalIdentity = `${created.dev}:${created.ino}`;
    const assertCreated = () => {
      assertAnchor();
      if (assertPrivate(journalPath, false) !== journalIdentity) {
        throw new Error("Package publication journal identity changed");
      }
    };
    assertCreated();
    const encoded = descriptorJson({ ...descriptor, journalIdentity });
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
        queries(db)
          .insertInto("package_activation")
          .values({
            slot: 1,
            revision: 0,
            phase: "preparing",
            descriptor_json: encoded,
            intent_json: JSON.stringify({ kind: "prepare", completed: [], moving: null }),
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
