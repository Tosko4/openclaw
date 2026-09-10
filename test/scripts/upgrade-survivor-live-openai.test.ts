import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

function runLiveUpgrade(failure = "", previousReceipts = false) {
  const home = tempDirs.make("survivor-live-openai-");
  const bin = join(home, "bin");
  const artifacts = join(home, "artifacts");
  mkdirSync(bin);
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
        baseline_version=2026.7.1
        baseline_spec=openclaw@2026.7.1
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
assert.equal(args[0], "agent");
assert(args.includes("--local"));
assert.equal(process.env.OPENAI_API_KEY, "live-key-not-for-output");
assert.equal(process.env.OPENCLAW_SKIP_PROVIDERS, undefined);
const stage = process.env.FIXTURE_INSTALLED_VERSION === "2026.7.1" ? "baseline" : "candidate";
fs.appendFileSync(process.env.HOME + "/events", stage + "\\n");
fs.appendFileSync(process.env.HOME + "/calls", JSON.stringify({ agent: value("--agent"), stage }) + "\\n");
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
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(home, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summary,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1",
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
  return {
    result,
    events: readFileSync(join(home, "events"), "utf8").trim().split("\n"),
    calls: readFileSync(join(home, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    summary: JSON.parse(readFileSync(summary, "utf8")),
    baseline: receipt("baseline"),
    candidate: receipt("candidate"),
  };
}

describe.skipIf(process.platform === "win32")("paired survivor OpenAI inference", () => {
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
