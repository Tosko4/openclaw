import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";

const order = JSON.parse(
  readFileSync(new URL("./reclamation-order.json", import.meta.url), "utf8"),
);

export default class ReclamationDiagnosticSequencer extends BaseSequencer {
  async sort(files) {
    const byPath = new Map(
      files.map((file) => [relative(process.cwd(), file.moduleId).replaceAll("\\", "/"), file]),
    );
    if (files.length !== order.length || byPath.size !== order.length) {
      throw new Error("Diagnostic selection differs from the original 34-file group");
    }
    return order.map((path) => {
      const file = byPath.get(path);
      if (!file) throw new Error("Original diagnostic file is absent: " + path);
      return file;
    });
  }
}
