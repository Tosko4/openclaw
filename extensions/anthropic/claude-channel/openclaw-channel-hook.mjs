#!/usr/bin/env node
// Claude Code hook for OpenClaw live local sessions. Claude Code runs it for
// SessionStart / UserPromptSubmit / Stop / SessionEnd with the hook JSON on
// stdin; it forwards {session_id, cwd} to the OpenClaw bridge socket so the
// node host can pair the channel server process with its Claude session and
// see turn boundaries. Always exits 0: a missing bridge must never block Claude.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function resolveBridgeEndpoint(env = process.env) {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = override
    ? path.resolve(override.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(os.homedir(), ".openclaw");
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\openclaw-claude-channel-${digest}`;
  }
  return path.join(stateDir, "node", "claude-channel.sock");
}

// Claude Code runs hooks through a shell and spawns the channel MCP server
// directly, so the Claude process is an ancestor of this hook and the parent of
// the channel process. Ancestry is the only identity shared by both; cwd is not.
function readAncestorPids(env = process.env) {
  // Windows has no `ps`; an unmatched partial chain would block the bridge's
  // cwd fallback, so report no ancestry there.
  if (process.platform === "win32") {
    return [];
  }
  const pids = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    pids.push(pid);
    try {
      const parent = Number.parseInt(
        execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 500,
        }).trim(),
        10,
      );
      if (!Number.isInteger(parent) || parent === pid) {
        break;
      }
      pid = parent;
    } catch {
      process.stderr.write(
        "[openclaw/claude-hook] could not read process ancestry; channel pairing may be unavailable\n",
      );
      break;
    }
  }
  return pids;
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.stderr.write(
      "[openclaw/claude-hook] ignored invalid hook JSON; no lifecycle event delivered\n",
    );
    process.exit(0);
  }
  const frame = {
    type: "hook",
    event: payload.hook_event_name,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    ancestorPids: readAncestorPids(),
  };
  const endpoint = resolveBridgeEndpoint();
  const socket = net.createConnection(endpoint);
  const finish = () => process.exit(0);
  socket.setTimeout(1_000, () => {
    process.stderr.write(
      `[openclaw/claude-hook] bridge timed out at ${endpoint}; check the node host and OPENCLAW_STATE_DIR\n`,
    );
    socket.destroy();
  });
  socket.on("connect", () => socket.end(`${JSON.stringify(frame)}\n`));
  socket.on("error", (error) => {
    process.stderr.write(
      `[openclaw/claude-hook] lifecycle event not delivered to ${endpoint} (${error.code ?? "socket error"}); check the node host and OPENCLAW_STATE_DIR\n`,
    );
    finish();
  });
  socket.on("close", finish);
});
