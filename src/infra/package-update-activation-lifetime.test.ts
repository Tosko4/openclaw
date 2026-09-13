import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import { preparePackageActivationJournal } from "./package-update-activation-prepare.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
  assertNoPendingPackageActivation,
} from "./package-update-activation.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as runtimeWorker from "./runtime-worker-url.js";
import * as temporaryRoot from "./tmp-openclaw-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("activation-lifetime-"));
  const tmp = path.join(root, "private-tmp");
  fs.mkdirSync(tmp, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(tmp);
  const helper = path.join(root, "sealed.mjs");
  fs.writeFileSync(helper, "// inert sealed helper bytes\n");
  vi.spyOn(runtimeWorker, "resolveRuntimeWorkerUrl").mockReturnValue(pathToFileURL(helper));
});
afterEach(() => vi.restoreAllMocks());

async function prepare(cut?: (anchor: string) => void) {
  const f = await createPackageSwapFixture(root);
  const anchor = resolvePackageActivationAnchor(f.packageRoot);
  const previous = await createPackageIntegrityReader().tree(f.packageRoot);
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(f.packageRoot);
    cut?.(anchor);
    await preparePackageActivationJournal({
      options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
      liveRoot: f.packageRoot,
      stageRoot: f.params.stage.packageRoot,
      launcherRoot: f.params.stage.layout.binDir,
      binDir: path.dirname(f.launcher),
      previous,
      launchers: [
        { name: "openclaw", previous: await createPackageIntegrityReader().launcher(f.launcher) },
      ],
    });
  });
  return { ...f, anchor };
}

describe("package activation custody and surviving completion", () => {
  it("does not create recovery artifacts when the sealed helper preflight fails", async () => {
    fs.unlinkSync(path.join(root, "sealed.mjs"));
    let anchor = "";
    await expect(
      prepare((selected) => {
        anchor = selected;
      }),
    ).rejects.toThrow("ENOENT");
    for (const file of [anchor, `${anchor}.sqlite`, `${anchor}.recovery.mjs`]) {
      expect(fs.lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
    }
  });

  it("does not treat a dangling foreign receipt link as absence", async () => {
    const f = await createPackageSwapFixture(root);
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const receipt = `${anchor}.sqlite`;
    fs.symlinkSync(path.join(root, "missing"), receipt);
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow("unsafe identity");
    expect(fs.lstatSync(receipt).isSymbolicLink()).toBe(true);
  });

  it("has durable exact custody and a transfer intent before the first staged rename", async () => {
    const rename = fsp.rename.bind(fsp);
    let observed = false;
    await prepare((anchor) => {
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (to === path.join(anchor, "candidate")) {
          const record = openPackageActivationJournal(anchor).read();
          expect(record.phase).toBe("preparing");
          expect(record.intent).toMatchObject({ kind: "prepare", moving: "candidate" });
          expect(record.descriptor.candidate.identity).toBe(
            `${fs.lstatSync(from).dev}:${fs.lstatSync(from).ino}`,
          );
          observed = true;
        }
        await rename(from, to);
      });
    });
    expect(observed).toBe(true);
  });

  it("retains positive completion outside the anchor and remains readable after helper removal", async () => {
    const f = await prepare();
    await expect(runPackageActivationRecovery(f.anchor, "repair")).resolves.toMatchObject({
      phase: "aborted",
    });
    await expect(runPackageActivationRecovery(f.anchor, "retire")).resolves.toMatchObject({
      phase: "complete",
    });
    expect(fs.existsSync(f.anchor)).toBe(false);
    expect(fs.existsSync(`${f.anchor}.recovery.mjs`)).toBe(false);
    await expect(readPackageActivationStatus(f.anchor)).resolves.toMatchObject({
      phase: "complete",
    });
    expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
  });
  it.each(["candidate", "launchers"])(
    "reconciles lost %s transfer acknowledgement without adopting another object",
    async (name) => {
      const failure = new Error("transfer acknowledgement lost");
      let selectedAnchor = "";
      const rename = fsp.rename.bind(fsp);
      let cut = false;
      await expect(
        prepare((anchor) => {
          selectedAnchor = anchor;
          vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
            await rename(from, to);
            if (!cut && to === path.join(anchor, name)) {
              cut = true;
              throw failure;
            }
          });
        }),
      ).rejects.toBe(failure);
      expect(cut).toBe(true);
      vi.mocked(fsp.rename).mockRestore();
      const recorded = openPackageActivationJournal(selectedAnchor).read();
      expect(recorded.intent).toMatchObject({ kind: "prepare", moving: name });
      await expect(runPackageActivationRecovery(selectedAnchor, "repair")).resolves.toMatchObject({
        phase: "aborted",
      });
      await expect(runPackageActivationRecovery(selectedAnchor, "retire")).resolves.toMatchObject({
        phase: "complete",
      });
    },
  );

  it.each(["anchor-before", "anchor-after", "helper-before", "helper-after"])(
    "recovers the exact %s terminal cut",
    async (cut) => {
      const f = await prepare();
      await runPackageActivationRecovery(f.anchor, "repair");
      const failure = new Error(cut);
      const removeAnchor = fsp.rmdir.bind(fsp);
      const unlink = fsp.unlink.bind(fsp);
      let interrupted = false;
      vi.spyOn(fsp, "rmdir").mockImplementation(async (file, ...args) => {
        if (file === f.anchor && cut.startsWith("anchor")) {
          interrupted = true;
          if (cut === "anchor-after") {
            await removeAnchor(file, ...args);
          }
          throw failure;
        }
        await removeAnchor(file, ...args);
      });
      vi.spyOn(fsp, "unlink").mockImplementation(async (file) => {
        if (file === `${f.anchor}.recovery.mjs` && cut.startsWith("helper")) {
          const record = openPackageActivationJournal(f.anchor).read();
          expect(record.phase).toBe("anchor-retired");
          expect(record.intent).toMatchObject({
            kind: "unlink-helper",
            identity: record.descriptor.helperIdentity,
          });
          interrupted = true;
          if (cut === "helper-after") {
            await unlink(file);
          }
          throw failure;
        }
        await unlink(file);
      });
      await expect(runPackageActivationRecovery(f.anchor, "retire")).rejects.toBe(failure);
      expect(interrupted).toBe(true);
      vi.mocked(fsp.rmdir).mockRestore();
      vi.mocked(fsp.unlink).mockRestore();
      await expect(runPackageActivationRecovery(f.anchor, "retire")).resolves.toMatchObject({
        phase: "complete",
      });
      await expect(readPackageActivationStatus(f.anchor)).resolves.toMatchObject({
        phase: "complete",
      });
      expect(fs.existsSync(f.anchor)).toBe(false);
    },
  );

  it("refuses a byte-equal replacement helper and preserves unknown anchor objects", async () => {
    const f = await prepare();
    await runPackageActivationRecovery(f.anchor, "repair");
    const helper = `${f.anchor}.recovery.mjs`;
    const saved = `${helper}.saved`;
    fs.renameSync(helper, saved);
    fs.copyFileSync(saved, helper);
    await expect(runPackageActivationRecovery(f.anchor, "retire")).rejects.toThrow(
      "helper identity changed",
    );
    expect(fs.existsSync(f.anchor)).toBe(true);
    fs.unlinkSync(helper);
    fs.renameSync(saved, helper);
    const unknown = path.join(f.anchor, "foreign");
    fs.writeFileSync(unknown, "keep");
    await expect(runPackageActivationRecovery(f.anchor, "retire")).rejects.toThrow("Unknown");
    expect(fs.readFileSync(unknown, "utf8")).toBe("keep");
  });

  it.each([
    "staged-anchor",
    "staged-helper",
    "stable-anchor",
    "stable-helper",
    "before-commit",
    "after-commit",
  ])(
    "keeps operation A complete or operation B recoverable after %s replacement cut",
    async (cut) => {
      const first = await prepare();
      await runPackageActivationRecovery(first.anchor, "repair");
      await runPackageActivationRecovery(first.anchor, "retire");
      const before = openPackageActivationJournal(first.anchor).read();
      const failure = new Error(cut);
      const mkdir = fsp.mkdtemp.bind(fsp);
      const write = fs.writeFileSync.bind(fs);
      const rename = fsp.rename.bind(fsp);
      const open = nodeSqlite.openNodeSqliteDatabase;
      let fired = false;
      vi.spyOn(fsp, "mkdtemp").mockImplementation(async (prefix, options) => {
        const created = await mkdir(prefix, options);
        if (!fired && cut === "staged-anchor" && prefix.includes(".activation-anchor-")) {
          fired = true;
          throw failure;
        }
        return created;
      });
      vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        write(file, data, options);
        if (
          !fired &&
          cut === "staged-helper" &&
          String(file).includes(".activation-anchor-") &&
          String(file).endsWith(".recovery.mjs")
        ) {
          fired = true;
          throw failure;
        }
      });
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (
          !fired &&
          ((cut === "stable-anchor" && to === first.anchor) ||
            (cut === "stable-helper" && to === `${first.anchor}.recovery.mjs`))
        ) {
          fired = true;
          throw failure;
        }
      });
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
        const db = open(file, options);
        if (db.location() === `${first.anchor}.sqlite`) {
          const exec = db.exec.bind(db);
          db.exec = (statement) => {
            if (!fired && statement === "COMMIT" && cut === "before-commit") {
              fired = true;
              throw failure;
            }
            exec(statement);
            if (!fired && statement === "COMMIT" && cut === "after-commit") {
              fired = true;
              throw failure;
            }
          };
        }
        return db;
      });
      await expect(prepare()).rejects.toBe(failure);
      expect(fired).toBe(true);
      vi.mocked(fsp.mkdtemp).mockRestore();
      vi.mocked(fs.writeFileSync).mockRestore();
      vi.mocked(fsp.rename).mockRestore();
      vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockRestore();
      const after = openPackageActivationJournal(first.anchor).read();
      if (["staged-anchor", "staged-helper", "before-commit"].includes(cut)) {
        expect(after).toEqual(before);
        await expect(readPackageActivationStatus(first.anchor)).resolves.toMatchObject({
          phase: "complete",
        });
        expect(() => assertNoPendingPackageActivation(first.packageRoot)).not.toThrow();
        await expect(runPackageActivationRecovery(first.anchor, "retire")).resolves.toMatchObject({
          phase: "complete",
        });
      } else {
        expect(after.descriptor.operationId).not.toBe(before.descriptor.operationId);
        expect(after.phase).toBe("preparing");
        expect(() => assertNoPendingPackageActivation(first.packageRoot)).toThrow("incomplete");
        await expect(runPackageActivationRecovery(first.anchor, "repair")).resolves.toMatchObject({
          phase: "aborted",
        });
        await expect(runPackageActivationRecovery(first.anchor, "retire")).resolves.toMatchObject({
          phase: "complete",
        });
      }
    },
  );

  it("reads completion through the actual status command after the helper is removed", async () => {
    const f = await prepare();
    await runPackageActivationRecovery(f.anchor, "repair");
    await runPackageActivationRecovery(f.anchor, "retire");
    const shared = await import("../cli/update-cli/shared.js");
    const config = await import("../config/config.js");
    const diagnostics = await import("../commands/node-runtime-diagnostics.js");
    const checks = await import("./update-check.js");
    const runs = await import("./update-run-status.js");
    const { defaultRuntime } = await import("../runtime.js");
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(f.packageRoot);
    vi.spyOn(config, "readSourceConfigBestEffort").mockResolvedValue({});
    vi.spyOn(diagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
    vi.spyOn(checks, "checkUpdateStatus").mockResolvedValue({
      root: f.packageRoot,
      installKind: "package",
      packageManager: "npm",
    });
    vi.spyOn(runs, "readUpdateRunStatus").mockReturnValue({});
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const { updateStatusCommand } = await import("../cli/update-cli/status.js");
    await updateStatusCommand({ json: true });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        packageActivation: expect.objectContaining({ phase: "complete" }),
      }),
    );
    expect(fs.existsSync(`${f.anchor}.recovery.mjs`)).toBe(false);
  });

  it.each(["after-custody", "before-replacement"])(
    "preserves the actual stage-finally custody boundary on %s failure",
    async (cut) => {
      const f = await prepare();
      await runPackageActivationRecovery(f.anchor, "repair");
      await runPackageActivationRecovery(f.anchor, "retire");
      const { runGlobalPackageUpdateSteps } = await import("./package-update-steps.js");
      const { createRootRunner, writePackageRoot } =
        await import("./package-update-steps.test-support.js");
      const capability = await import("./update-post-core-capability.js");
      vi.spyOn(capability, "supportsPostCoreExecutor").mockResolvedValue(true);
      const failure = new Error(cut);
      const rename = fsp.rename.bind(fsp);
      const open = nodeSqlite.openNodeSqliteDatabase;
      let fired = false;
      let stagePrefix = "";
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (!fired && cut === "after-custody" && to === f.anchor) {
          fired = true;
          throw failure;
        }
      });
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
        const db = open(file, options);
        if (db.location() === `${f.anchor}.sqlite`) {
          const exec = db.exec.bind(db);
          db.exec = (statement) => {
            if (!fired && cut === "before-replacement" && statement === "COMMIT") {
              fired = true;
              throw failure;
            }
            exec(statement);
          };
        }
        return db;
      });
      const result = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        return runGlobalPackageUpdateSteps({
          installTarget: f.params.installTarget,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot: f.packageRoot,
          runCommand: createRootRunner(f.globalRoot),
          timeoutMs: 5000,
          activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          runStep: async ({ name, argv, cwd }) => {
            if (name !== "global update") {
              throw new Error(`unexpected package-manager leaf ${name}`);
            }
            const prefix = argv[argv.indexOf("--prefix") + 1];
            if (!prefix) {
              throw new Error("No private staging prefix");
            }
            stagePrefix = prefix;
            await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2.0.0");
            await fsp.mkdir(path.join(prefix, "bin"), { recursive: true });
            await fsp.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
            return { name, command: argv.join(" "), cwd: cwd ?? root, durationMs: 0, exitCode: 0 };
          },
        });
      });
      expect(fired).toBe(true);
      expect(result.failedStep?.stderrTail).toContain(cut);
      vi.mocked(fsp.rename).mockRestore();
      vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockRestore();
      expect(fs.existsSync(stagePrefix)).toBe(cut === "after-custody");
      if (cut === "after-custody") {
        await runPackageActivationRecovery(f.anchor, "repair");
        await runPackageActivationRecovery(f.anchor, "retire");
      }
      await expect(readPackageActivationStatus(f.anchor)).resolves.toMatchObject({
        phase: "complete",
      });
    },
  );

  it("replaces only the completed one-slot receipt under new original-store admission", async () => {
    const first = await prepare();
    await runPackageActivationRecovery(first.anchor, "repair");
    await runPackageActivationRecovery(first.anchor, "retire");
    const before = openPackageActivationJournal(first.anchor).read();
    const second = await prepare();
    const after = openPackageActivationJournal(second.anchor).read();
    expect(after.descriptor.journalIdentity).toBe(before.descriptor.journalIdentity);
    expect(after.descriptor.operationId).not.toBe(before.descriptor.operationId);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.phase).toBe("prepared");
  });
});
