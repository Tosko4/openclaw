import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hookPath = fileURLToPath(
  new URL("./claude-channel/openclaw-channel-hook.mjs", import.meta.url),
);

function runHook(
  stateDir: string,
  payload: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(payload);
  });
}

describe("Claude lifecycle hook failures", () => {
  it("reports missing bridge delivery without blocking Claude or exposing the prompt", async () => {
    const stateDir = tempDirs.make("claude-hook-");
    const result = await runHook(
      stateDir,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "test-session",
        cwd: stateDir,
        prompt: "private prompt must not be logged",
      }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("lifecycle event not delivered");
    expect(result.stderr).toContain(
      process.platform === "win32"
        ? "openclaw-claude-channel-"
        : path.join(stateDir, "node", "claude-channel.sock"),
    );
    expect(result.stderr).toContain("OPENCLAW_STATE_DIR");
    expect(result.stderr).not.toContain("private prompt");
  });

  it("reports malformed input without blocking Claude or echoing it", async () => {
    const result = await runHook(tempDirs.make("claude-hook-"), "private malformed input");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ignored invalid hook JSON");
    expect(result.stderr).not.toContain("private malformed input");
  });
});
