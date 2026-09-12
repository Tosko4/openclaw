import { createHash } from "node:crypto";

export const frozenBaseline = "86b278d43c0352db8bd38667d962f46fca1a6b4c";
export const harnessPrefix = "qa/.gateway-memory-live/";
export const blobOid = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export function parseTree(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
      if (!match) throw new Error("Unsupported production tree entry");
      return { mode: match[1], oid: match[2], file: match[3] };
    });
}
export function treeOid(entries) {
  const root = new Map();
  for (const entry of entries) {
    const parts = entry.file.split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || entry.file.includes("\\"))
      throw new Error("Unsafe production source path");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let child = directory.get(part);
      if (!child) {
        child = new Map();
        directory.set(part, child);
      }
      if (!(child instanceof Map)) throw new Error("Overlapping source tree entries");
      directory = child;
    }
    const name = parts.at(-1);
    if (directory.has(name)) throw new Error("Duplicate source tree entry");
    directory.set(name, entry);
  }
  const digest = (directory) => {
    const records = [...directory].map(([name, value]) =>
      value instanceof Map
        ? { name, mode: "40000", oid: digest(value), sort: `${name}/` }
        : { name, ...value, sort: name },
    );
    records.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    const bytes = Buffer.concat(
      records.flatMap(({ mode, name, oid }) => [
        Buffer.from(`${mode} ${name}\0`),
        Buffer.from(oid, "hex"),
      ]),
    );
    return createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex");
  };
  return digest(root);
}
