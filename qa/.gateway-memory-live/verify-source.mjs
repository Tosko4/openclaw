import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { frozenBaseline, harnessPrefix, parseTree, blobOid, treeOid } from "./source-tree.mjs";
const directory = "qa/.gateway-memory-live";
const source = JSON.parse(fs.readFileSync(`${directory}/adapter-source.json`, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  hash(fs.readFileSync(source.canonical, "utf8").replaceAll("\r\n", "\n")) !==
  source.canonicalSha256
)
  throw new Error("Canonical benchmark changed after adapter generation");
if (hash(fs.readFileSync(`${directory}/live-bench.ts`)) !== source.adapterSha256)
  throw new Error("Generated live benchmark changed");
for (const [name, expected] of Object.entries(source.heapCollector.helpers)) {
  if (hash(fs.readFileSync(`scripts/lib/${name}`)) !== expected)
    throw new Error(`Frozen heap collector changed: ${name}`);
}
const manifest = JSON.parse(fs.readFileSync(`${directory}/source-manifest.json`, "utf8"));
if (
  manifest.frozenBaseline !== frozenBaseline ||
  source.sourceCommit !== frozenBaseline ||
  source.sourceTree !== manifest.baselineTree
)
  throw new Error("Prepared source metadata does not bind the frozen baseline");
if (treeOid(manifest.baselineEntries) !== manifest.baselineTree)
  throw new Error("Complete frozen source manifest does not reconstruct its Git tree");
const overlays = new Map(manifest.overlays.map((entry) => [entry.file, entry]));
if (overlays.size !== manifest.overlays.length) throw new Error("Duplicate candidate overlay");
const baselinePaths = new Set(manifest.baselineEntries.map((entry) => entry.file));
const expected = [
  ...manifest.baselineEntries.map((entry) => overlays.get(entry.file) ?? entry),
  ...manifest.overlays.filter((entry) => !baselinePaths.has(entry.file)),
];
if (treeOid(expected) !== manifest.expectedProductTree)
  throw new Error("Expected complete product tree mismatch");
const actualTree = parseTree(
  execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }),
).filter(({ file }) => !file.startsWith(harnessPrefix));
if (treeOid(actualTree) !== manifest.expectedProductTree)
  throw new Error("Complete materialized carrier product tree differs from accepted source");
for (const entry of expected) {
  const info = fs.lstatSync(entry.file);
  let bytes;
  if (entry.mode === "120000") {
    if (!info.isSymbolicLink()) throw new Error(`Expected production symlink: ${entry.file}`);
    bytes = fs.readlinkSync(entry.file, { encoding: "buffer" });
  } else {
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      ((info.mode & 0o100) !== 0) !== (entry.mode === "100755")
    )
      throw new Error(`Production file kind/mode mismatch: ${entry.file}`);
    bytes = fs.readFileSync(entry.file);
  }
  if (blobOid(bytes) !== entry.oid)
    throw new Error(`Materialized production bytes changed: ${entry.file}`);
}
console.log(
  JSON.stringify(
    {
      ...source,
      fullProductionProof: {
        frozenBaseline,
        baselineTree: manifest.baselineTree,
        expectedProductTree: manifest.expectedProductTree,
        files: expected.length,
        acceptedOverlays: manifest.overlays,
        manifestSha256: hash(fs.readFileSync(`${directory}/source-manifest.json`)),
        completeRawBytesModesAndKindsVerified: true,
      },
    },
    null,
    2,
  ),
);
