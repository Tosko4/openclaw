import "./sealed-runtime-bootstrap.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "./errors.js";
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationHelper,
} from "./package-update-activation-journal.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { isSupportedNodeVersion } from "./runtime-guard.js";

try {
  if (
    process.platform === "win32" ||
    !isSupportedNodeVersion(process.versions.node) ||
    process.versions.bun
  ) {
    throw new Error("Package publication recovery requires supported external Node on POSIX.");
  }
  const explicitAnchor = process.argv[2] === "--anchor" ? process.argv[3] : undefined;
  const action = process.argv[explicitAnchor ? 4 : 2];
  if (
    process.argv.length !== (explicitAnchor ? 5 : 3) ||
    (action !== "status" && action !== "repair" && action !== "retire")
  ) {
    throw new Error("Usage: node recovery.mjs [--anchor absolute-path] status|repair|retire");
  }
  const helper = fileURLToPath(import.meta.url);
  if (!helper.endsWith(".recovery.mjs")) {
    throw new Error("Unrecognized package recovery helper location.");
  }
  const anchor = explicitAnchor ?? helper.slice(0, -".recovery.mjs".length);
  if (path.resolve(anchor) !== anchor) {
    throw new Error("Package recovery anchor must be an absolute canonical path.");
  }
  const record = openPackageActivationJournal(anchor).read();
  const stagedHelper = record.descriptor.preparation.find(
    (entry) => entry.name === "helper",
  )?.source;
  if (
    (helper !== resolvePackageActivationHelper(anchor) && helper !== stagedHelper) ||
    packageActivationIdentity(helper, false) !== record.descriptor.helperIdentity ||
    createHash("sha256").update(fs.readFileSync(helper)).digest("hex") !==
      record.descriptor.helperDigest
  ) {
    throw new Error("Invoked helper is not the recorded package recovery object.");
  }
  if (action === "repair") {
    console.error(
      "Repair may republish the recorded candidate into a missing installation. Keep other package managers stopped. This does not restart or verify the Gateway.",
    );
  }
  const result =
    action === "status"
      ? await readPackageActivationStatus(anchor)
      : await runPackageActivationRecovery(anchor, action);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Package publication recovery refused: ${formatErrorMessage(error)}`);
  process.exitCode = 1;
}
