import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { frozenBaseline, harnessPrefix, parseTree, blobOid, treeOid } from "./source-tree.mjs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
const allowed = new Set(process.argv.slice(2));
if (allowed.size !== process.argv.length - 2) throw new Error("Duplicate accepted candidate path");
const baselineEntries = parseTree(git("ls-tree", "-r", "-z", frozenBaseline));
if (baselineEntries.some(({ file }) => file.startsWith(harnessPrefix)))
  throw new Error("Task harness collides with frozen production source");
const baselineTree = git("rev-parse", `${frozenBaseline}^{tree}`);
if (treeOid(baselineEntries) !== baselineTree)
  throw new Error("Complete frozen source tree reconstruction failed");
const extras = git("ls-files", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.startsWith(harnessPrefix));
if (extras.some((file) => !allowed.has(file)))
  throw new Error(
    `Untracked production source is not part of accepted candidate: ${JSON.stringify(extras)}`,
  );
const changed = [
  ...new Set([
    ...git("diff", "--name-only", "-z", frozenBaseline)
      .split("\0")
      .filter(Boolean)
      .filter((file) => !file.startsWith(harnessPrefix)),
    ...extras,
  ]),
];
if (changed.length !== allowed.size || changed.some((file) => !allowed.has(file)))
  throw new Error(
    `Source changes differ from explicitly accepted candidate paths: ${JSON.stringify(changed)}`,
  );
const baselineByPath = new Map(baselineEntries.map((entry) => [entry.file, entry]));
const overlays = changed.map((file) => {
  const baseline = baselineByPath.get(file);
  if (baseline?.mode === "120000")
    throw new Error("This bounded proof accepts regular file changes only");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Candidate file kind changed");
  const mode = (stat.mode & 0o100) !== 0 ? "100755" : "100644";
  if (baseline && baseline.mode !== mode) throw new Error("Candidate executable mode changed");
  return { file, mode, oid: blobOid(fs.readFileSync(file)) };
});
const overlayByPath = new Map(overlays.map((entry) => [entry.file, entry]));
const expectedEntries = [
  ...baselineEntries.map((entry) => overlayByPath.get(entry.file) ?? entry),
  ...overlays.filter((entry) => !baselineByPath.has(entry.file)),
];
const manifest = {
  frozenBaseline,
  baselineTree,
  expectedProductTree: treeOid(expectedEntries),
  baselineEntries,
  overlays,
};
fs.writeFileSync(`${harnessPrefix}source-manifest.json`, JSON.stringify(manifest));
console.log(
  JSON.stringify({
    frozenBaseline,
    baselineTree,
    expectedProductTree: manifest.expectedProductTree,
    files: baselineEntries.length,
    overlays,
  }),
);
