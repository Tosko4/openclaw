import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

export const PACKAGE_ACTIVATION_JOURNAL = "operation.sqlite";
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
const PackageActivationDescriptorSchema = z.strictObject({
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
  "prepared",
  "publishing",
  "publication-complete",
  "rollback-in-progress",
  "rolled-back",
  "aborted",
  "retiring",
  "retired",
]);
export type PackageActivationPhase = z.infer<typeof PackageActivationPhaseSchema>;
const intentSchema = z
  .union([
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
export type ActivationRow = {
  slot: number;
  revision: number;
  phase: string;
  descriptor_json: string;
  intent_json: string;
  publications_json: string;
};
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

export function assertPrivatePackageActivationFile(file: string, directory: boolean): string {
  const value = packageActivationIdentity(file, directory);
  const stat = fs.lstatSync(file);
  if ((stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new Error("Package publication recovery permissions are unsafe");
  }
  return value;
}

export function encodePackageActivationDescriptor(descriptor: PackageActivationDescriptor): string {
  const encoded = JSON.stringify(PackageActivationDescriptorSchema.parse(descriptor));
  if (Buffer.byteLength(encoded) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES) {
    throw new Error("Package publication descriptor exceeds 1 MiB");
  }
  return encoded;
}

function decodePackageActivationRecord(
  row: ActivationRow | undefined,
  binding: PackageActivationRecordBinding,
): PackageActivationRecord {
  const { anchor, anchorIdentity, journalIdentity } = binding;
  if (
    !row ||
    ![row.descriptor_json, row.intent_json, row.publications_json].every(
      (value) =>
        typeof value === "string" &&
        Buffer.byteLength(value) <= MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES,
    ) ||
    row.slot !== 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    throw new Error("Package publication journal is missing or invalid");
  }
  const descriptor = PackageActivationDescriptorSchema.parse(JSON.parse(row.descriptor_json));
  if (
    (binding.store.kind === "authority" &&
      (descriptor.authority.installKey !== binding.store.identity.installKey ||
        descriptor.authority.databasePath !== binding.store.identity.databasePath ||
        descriptor.authority.databaseIdentity !== binding.store.identity.databaseIdentity ||
        descriptor.authority.parentIdentity !== binding.store.identity.parentIdentity)) ||
    descriptor.anchorIdentity !== anchorIdentity ||
    descriptor.journalIdentity !== journalIdentity ||
    resolvePackageActivationAnchor(descriptor.authority.installKey) !== anchor ||
    descriptor.parentIdentity !== packageActivationIdentity(path.dirname(anchor), true) ||
    new Set(descriptor.launchers.map((entry) => entry.name)).size !== descriptor.launchers.length
  ) {
    throw new Error("Package publication journal does not match its installation");
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
}

export type PackageActivationRecordBinding = Readonly<{
  anchor: string;
  anchorIdentity: string;
  journalIdentity: string;
  store:
    | Readonly<{ kind: "sibling" }>
    | Readonly<{
        kind: "authority";
        identity: Readonly<PackageActivationDescriptor["authority"]>;
      }>;
}>;

/** Read only through the admitted connection. The binding is not a grant. */
export function readPackageActivationRecord(
  db: DatabaseSync,
  binding: PackageActivationRecordBinding,
): PackageActivationRecord {
  if (!db.isTransaction) {
    throw new Error("Package publication record requires an owned snapshot.");
  }
  if (binding.store.kind === "authority") {
    const { identity: authority } = binding.store;
    if (
      db.location() !== authority.databasePath ||
      assertPrivatePackageActivationFile(authority.databasePath, false) !==
        authority.databaseIdentity ||
      packageActivationIdentity(path.dirname(authority.databasePath), true) !==
        authority.parentIdentity ||
      assertPrivatePackageActivationFile(binding.anchor, true) !== binding.anchorIdentity ||
      path.resolve(authority.installKey) !== authority.installKey ||
      path.resolve(authority.databasePath) !== authority.databasePath ||
      authority.databaseIdentity !== binding.journalIdentity ||
      resolvePackageActivationAnchor(authority.installKey) !== binding.anchor
    ) {
      throw new Error("Package publication record scope is invalid");
    }
  }
  const sqlDb = getNodeSqliteKysely<{
    package_activation: ActivationRow;
    package_activation_operations: ActivationRow & { install_key: string };
  }>(db);
  const columns = [
    "slot",
    "revision",
    "phase",
    "descriptor_json",
    "intent_json",
    "publications_json",
  ] as const;
  const scoped =
    binding.store.kind === "sibling"
      ? sqlDb.selectFrom("package_activation").select(columns)
      : sqlDb
          .selectFrom("package_activation_operations")
          .where("install_key", "=", binding.store.identity.installKey)
          .select(columns);
  const selected = sqlDb.selectFrom(scoped.as("operation"));
  const sizes = executeSqliteQuerySync(
    db,
    selected
      .select([
        "slot",
        sql<number>`length(CAST(descriptor_json AS BLOB))`.as("descriptor_bytes"),
        sql<number>`length(CAST(intent_json AS BLOB))`.as("intent_bytes"),
        sql<number>`length(CAST(publications_json AS BLOB))`.as("publications_bytes"),
        sql<string>`typeof(descriptor_json)`.as("descriptor_type"),
        sql<string>`typeof(intent_json)`.as("intent_type"),
        sql<string>`typeof(publications_json)`.as("publications_type"),
      ])
      .limit(2),
  ).rows;
  const size = sizes[0];
  if (
    sizes.length !== 1 ||
    !size ||
    size.slot !== 1 ||
    [size.descriptor_type, size.intent_type, size.publications_type].some(
      (value) => value !== "text",
    ) ||
    [size.descriptor_bytes, size.intent_bytes, size.publications_bytes].some(
      (bytes) =>
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES,
    )
  ) {
    throw new Error("Package publication journal must contain one bounded operation.");
  }
  const rows = executeSqliteQuerySync(
    db,
    selected
      .select(["slot", "revision", "phase", "descriptor_json", "intent_json", "publications_json"])
      .limit(2),
  ).rows;
  if (rows.length !== 1) {
    throw new Error("Package publication journal must contain exactly one operation.");
  }
  return decodePackageActivationRecord(rows[0], binding);
}

export function encodePackageActivationIntent(intent: PackageActivationIntent): string {
  return JSON.stringify(intentSchema.parse(intent));
}

export function assertPackageActivationPhase(phase: PackageActivationPhase): void {
  PackageActivationPhaseSchema.parse(phase);
}
