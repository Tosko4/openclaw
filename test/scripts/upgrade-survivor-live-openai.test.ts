import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

function runLiveUpgrade(failure = "", previousReceipts = false, baselineVersion = "2026.7.1") {
  const home = tempDirs.make("survivor-live-openai-");
  const bin = join(home, "bin");
  const artifacts = join(home, "artifacts");
  mkdirSync(bin);
  const packageDir = join(home, "package");
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: failure === "package-name" ? "@openclaw/other" : "@openclaw/codex",
      version: failure === "package-version" ? "2026.9.4" : baselineVersion,
    }),
  );
  const tarball = join(home, "codex.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", home, "package"]);
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "root") { console.log(process.env.HOME + "/npm-root"); process.exit(0); }
assert.equal(args[0], "pack");
assert.equal(args[1], "@openclaw/codex@" + process.env.FIXTURE_BASELINE_VERSION);
assert(args.includes("--ignore-scripts"));
assert(args.includes("--registry=https://registry.npmjs.org"));
fs.copyFileSync(process.env.FIXTURE_TARBALL, path.join(args[args.indexOf("--pack-destination") + 1], "codex.tgz"));
fs.appendFileSync(process.env.HOME + "/events", "pack\\n");
console.log("codex.tgz");
`,
    { mode: 0o755 },
  );
  if (previousReceipts) {
    mkdirSync(artifacts);
    for (const stage of ["baseline", "candidate"]) {
      writeFileSync(join(artifacts, `live-openai-${stage}.json`), '{"status":"passed"}');
    }
  }
  const prelude = join(home, "bash-env");
  // Replace package/service boundaries, retaining the actual phase sequence,
  // live CLI invocation, receipt validation, traps and terminal summary.
  writeFileSync(
    prelude,
    `install_fixture_phases() {
  trap - DEBUG
  stop_gateway() { :; }
  cleanup() { :; }
  read_installed_version() { printf '%s' "$FIXTURE_INSTALLED_VERSION"; }
  phase() {
    CURRENT_PHASE="$1"
    shift
    case "$CURRENT_PHASE" in
      install-baseline)
        baseline_version="$FIXTURE_BASELINE_VERSION"
        baseline_spec="openclaw@$baseline_version"
        export FIXTURE_INSTALLED_VERSION="$baseline_version"
        ;;
      resolve-candidate) candidate_version=2026.9.4 ;;
      validate-baseline-config|seed-state|assert-survival)
        printf '%s\\n' "$CURRENT_PHASE" >>"$HOME/events"
        ;;
      update-candidate)
        printf 'update\\n' >>"$HOME/events"
        export FIXTURE_INSTALLED_VERSION="$candidate_version"
        installed_version="$candidate_version"
        ;;
      *live-openai*) "$@" ;;
    esac
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
  );
  writeFileSync(
    join(bin, "openclaw"),
    `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
async function main() {
if (args[0] === "plugins") {
  assert.equal(args[1], "install");
  if (args.includes("--help")) { console.log("--accept-capabilities"); return; }
  assert.equal(args[2], "@openclaw/codex@latest");
  assert(args.includes("--accept-capabilities"));
  const registry = process.env.NPM_CONFIG_REGISTRY;
  fs.writeFileSync(process.env.HOME + "/registry-url", registry);
  const metadata = await (await fetch(registry + "/@openclaw%2fcodex")).json();
  assert.equal(metadata["dist-tags"].latest, process.env.FIXTURE_BASELINE_VERSION);
  assert.deepEqual(Object.keys(metadata.versions), [process.env.FIXTURE_BASELINE_VERSION]);
  const selected = metadata.versions[metadata["dist-tags"].latest];
  const bytes = Buffer.from(await (await fetch(selected.dist.tarball)).arrayBuffer());
  assert.deepEqual(bytes, fs.readFileSync(process.env.FIXTURE_TARBALL));
  fs.appendFileSync(process.env.HOME + "/events", "install\\n");
  if (process.env.FIXTURE_FAILURE === "install") process.exit(43);
  const { writePluginInstallIndexForE2E } = await import(process.env.FIXTURE_PLUGIN_INDEX_MODULE);
  writePluginInstallIndexForE2E({installRecords: { codex: {
    source: "npm", spec: process.env.FIXTURE_FAILURE === "pinned" ? "@openclaw/codex@" + selected.version : args[2],
    version: selected.version, installPath: process.env.HOME + "/package",
    integrity: process.env.FIXTURE_FAILURE === "integrity" ? "sha512-wrong" : selected.dist.integrity,
  }}});
  return;
}
assert.equal(args[0], "agent");
assert.equal(process.env.NPM_CONFIG_REGISTRY, "http://127.0.0.1:1");
assert(args.includes("--local"));
assert.equal(process.env.OPENAI_API_KEY, "live-key-not-for-output");
assert.equal(process.env.OPENCLAW_SKIP_PROVIDERS, undefined);
const stage = process.env.FIXTURE_INSTALLED_VERSION === process.env.FIXTURE_BASELINE_VERSION ? "baseline" : "candidate";
if (stage === "baseline" && ["2026.8.1", "2026.8.2", "2026.9.1"].includes(process.env.FIXTURE_BASELINE_VERSION)) {
  const { readPluginInstallRecords } = await import(process.env.FIXTURE_PLUGIN_INDEX_MODULE);
  assert(readPluginInstallRecords().codex, "baseline runtime prerequisite missing");
}
fs.appendFileSync(process.env.HOME + "/events", stage + "\\n");
fs.appendFileSync(process.env.HOME + "/calls", JSON.stringify({ agent: value("--agent"), stage }) + "\\n");
const identityPath = process.env.OPENCLAW_TEST_WORKSPACE_DIR + "/ops/IDENTITY.md";
const identity = fs.readFileSync(identityPath, "utf8");
assert.match(identity, /Name:.*Ops/);
if (stage === "baseline") {
  assert.equal(fs.existsSync(process.env.OPENCLAW_TEST_WORKSPACE_DIR + "/IDENTITY.md"), false);
  fs.appendFileSync(identityPath, "\\nExisting operator customization.\\n");
} else {
  assert(identity.includes("Existing operator customization."));
}
if (process.env.FIXTURE_FAILURE === stage) process.exit(42);
const marker = value("--message").match(/OPENCLAW_UPGRADE_SURVIVOR_\\w+/)[0];
console.log(JSON.stringify({
  payloads: [{ text: marker }],
  meta: { agentMeta: {
    sessionId: value("--session-id"),
    provider: "openai",
    model: process.env.FIXTURE_FAILURE === "wrong-model" ? "other-model" : value("--model").slice(7),
  } },
}));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`,
    { mode: 0o755 },
  );
  const summary = join(artifacts, "summary.json");
  const result = spawnSync("bash", [runner], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      OPENCLAW_STATE_DIR: join(home, "state"),
      OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
      OPENCLAW_TEST_WORKSPACE_DIR: join(home, "workspace"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(home, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summary,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${baselineVersion}`,
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
      npm_config_registry: "http://127.0.0.1:1",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: join(home, "candidate-artifacts-not-yet-selected"),
      FIXTURE_TARBALL: tarball,
      FIXTURE_BASELINE_VERSION: baselineVersion,
      FIXTURE_PLUGIN_INDEX_MODULE: resolve("scripts/e2e/lib/plugin-index-sqlite.mjs"),
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
      OPENAI_API_KEY: "live-key-not-for-output",
      BASH_ENV: prelude,
      FIXTURE_FAILURE: failure,
    },
  });
  const receipt = (stage: string) => {
    const file = join(artifacts, `live-openai-${stage}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  const lines = (name: string) =>
    existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8").trim().split("\n") : [];
  return {
    result,
    registryUrl: lines("registry-url")[0],
    baselineError: lines("artifacts/live-openai-baseline.err").join("\n"),
    events: lines("events"),
    calls: lines("calls").map((line) => JSON.parse(line)),
    summary: JSON.parse(readFileSync(summary, "utf8")),
    baseline: receipt("baseline"),
    candidate: receipt("candidate"),
  };
}

describe.skipIf(process.platform === "win32")("paired survivor OpenAI inference", () => {
  it.each(["2026.8.1", "2026.8.2", "2026.9.1"])(
    "prepares historical runtime bytes before the %s baseline turn without pinning updates",
    async (version) => {
      const { result, events, baseline, candidate, registryUrl, baselineError } = runLiveUpgrade(
        "",
        false,
        version,
      );
      expect(result.status, result.stdout + result.stderr + baselineError).toBe(0);
      expect(events).toEqual([
        "validate-baseline-config",
        "pack",
        "install",
        "baseline",
        "seed-state",
        "update",
        "assert-survival",
        "candidate",
      ]);
      expect(baseline.version).toBe(version);
      expect(candidate.version).toBe("2026.9.4");
      expect(result.stdout + result.stderr).not.toContain("live-key-not-for-output");
      expect(registryUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      await expect(fetch(registryUrl!)).rejects.toThrow();
    },
  );

  it.each(["package-name", "package-version", "pinned", "integrity", "install"])(
    "rejects a %s prerequisite failure before inference or update and stops the registry",
    async (failure) => {
      const { result, events, summary, registryUrl } = runLiveUpgrade(failure, false, "2026.8.1");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(summary.failure.phase).toBe("prepare-live-openai-baseline");
      expect(events).not.toContain("baseline");
      expect(events).not.toContain("update");
      if (registryUrl) {
        await expect(fetch(registryUrl)).rejects.toThrow();
      }
    },
  );

  it.each([
    "2026.6.33",
    "2026.6.34",
    "2026.7.1",
    "2026.7.1-1",
    "2026.7.1-2",
    "2026.9.2",
    "2026.9.3",
  ])("leaves the already-working %s inference path unchanged", (version) => {
    const { result, events, registryUrl } = runLiveUpgrade("", false, version);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events).not.toContain("pack");
    expect(events).not.toContain("install");
    expect(registryUrl).toBeUndefined();
  });

  it("binds both CLI probe invocations to their installed versions around the update", () => {
    const { result, events, calls, summary, baseline, candidate } = runLiveUpgrade();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events).toEqual([
      "validate-baseline-config",
      "baseline",
      "seed-state",
      "update",
      "assert-survival",
      "candidate",
    ]);
    expect(summary.status).toBe("passed");
    const uploadedReceipts = [...result.stdout.matchAll(/^Live OpenAI receipt: (.+)$/gm)].map(
      (match) => JSON.parse(match[1]!),
    );
    expect(uploadedReceipts).toEqual([baseline, candidate]);
    expect(calls).toEqual([
      { agent: "ops", stage: "baseline" },
      { agent: "ops", stage: "candidate" },
    ]);
    for (const [stage, version, receipt] of [
      ["baseline", "2026.7.1", baseline],
      ["candidate", "2026.9.4", candidate],
    ]) {
      expect(receipt).toMatchObject({
        stage,
        version,
        model: "openai/gpt-5.6-luna",
        agent: "ops",
        status: "passed",
      });
    }
    expect(result.stdout + result.stderr + JSON.stringify(summary)).not.toContain(
      "live-key-not-for-output",
    );
  });

  it.each(["baseline", "candidate"])("fails closed on %s inference failure", (stage) => {
    const { result, events, summary, candidate } = runLiveUpgrade(stage);
    expect(result.status, result.stdout + result.stderr).toBe(42);
    expect(summary).toMatchObject({ status: "failed", failure: { phase: `live-openai-${stage}` } });
    expect(candidate).toBeNull();
    if (stage === "baseline") {
      expect(events).not.toContain("update");
    }
  });

  it("does not publish a prior attempt's receipts after baseline failure", () => {
    const { result, summary, baseline, candidate } = runLiveUpgrade("baseline", true);
    expect(result.status).toBe(42);
    expect([baseline, candidate]).toEqual([null, null]);
    expect(summary.liveOpenAI).toEqual({ baseline: null, candidate: null });
    expect(result.stdout).not.toContain("Live OpenAI receipt:");
  });

  it("rejects a successful reply from a different model", () => {
    const { result, summary, baseline, events } = runLiveUpgrade("wrong-model");
    expect(result.status).not.toBe(0);
    expect(summary).toMatchObject({ status: "failed", failure: { phase: "live-openai-baseline" } });
    expect(baseline).toBeNull();
    expect(events).not.toContain("update");
  });
});
