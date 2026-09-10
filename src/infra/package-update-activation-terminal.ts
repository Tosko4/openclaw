import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  assertPrivatePackageActivationFile,
  readPackageActivationRecord,
  resolvePackageActivationAnchor,
  type PackageActivationDescriptor,
  type PackageActivationRecord,
} from "./package-update-activation-record.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-schema.js";

export type PackageActivationTerminalRequest = Readonly<{
  expected: PackageActivationRecord;
  authority: Readonly<PackageActivationDescriptor["authority"]>;
}>;

/** Snapshot only; the caller must already own the original executor. */
export function snapshotPackageActivationTerminalRequest(
  record: PackageActivationRecord,
  authority: PackageActivationTerminalRequest["authority"],
): PackageActivationTerminalRequest {
  const request = { expected: structuredClone(record), authority };
  createManagedHandoffLeaseDatabase(authority.databasePath, authority)(false, (db) => {
    assertPackageActivationTerminalRecord(db, request);
  });
  return request;
}

/** Reads through the original admitted connection; this operation grants no ownership. */
function assertPackageActivationTerminalRecord(
  db: DatabaseSync,
  request: PackageActivationTerminalRequest,
): void {
  const { authority, expected } = request;
  assertManagedUpdateLeaseDatabaseIdentity(authority);
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  const actual = readPackageActivationRecord(db, {
    anchor,
    anchorIdentity: assertPrivatePackageActivationFile(anchor, true),
    journalIdentity: authority.databaseIdentity,
    store: { kind: "authority", identity: authority },
  });
  if (
    actual.phase !== "retired" ||
    actual.intent !== null ||
    !isDeepStrictEqual(actual, expected) ||
    path.resolve(authority.installKey) !== authority.installKey
  ) {
    throw new Error("Package activation terminal record is no longer current.");
  }
}

/** The original lease owner calls this inside its conditional release transaction. */
export function deletePackageActivationTerminalRecord(
  db: DatabaseSync,
  leases: readonly ManagedHandoffLease[],
  request: PackageActivationTerminalRequest,
): void {
  const original = leases.find((lease) => lease.key === request.authority.installKey);
  if (
    !original ||
    original.owner !== request.authority.owner ||
    original.version === 3 ||
    original.executor.pid !== process.pid ||
    original.helper.pid !== process.pid ||
    original.action.kind !== "update"
  ) {
    throw new Error("Package activation settlement requires the original direct executor.");
  }
  assertPackageActivationTerminalRecord(db, request);
  const query = getNodeSqliteKysely<{
    package_activation_operations: {
      install_key: string;
      slot: number;
      revision: number;
      descriptor_json: string;
    };
  }>(db)
    .deleteFrom("package_activation_operations")
    .where("install_key", "=", request.authority.installKey)
    .where("slot", "=", 1)
    .where("revision", "=", request.expected.revision)
    .where(
      sql<string>`json_extract(descriptor_json, '$.operationId')`,
      "=",
      request.expected.descriptor.operationId,
    );
  if (executeSqliteQuerySync(db, query).numAffectedRows !== 1n) {
    throw new Error("Package activation terminal compare-and-swap failed.");
  }
}
