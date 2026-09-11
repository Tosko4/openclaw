// Operator-facing setup facts for the Claude Code channel bridge. The CLI
// prints these; nothing here touches the filesystem so the description stays
// accurate whether or not Claude Code is installed yet.
import { fileURLToPath } from "node:url";
import { resolveClaudeChannelBridgeEndpoint } from "./local-session-bridge.js";

export const CLAUDE_CHANNEL_SERVER_NAME = "openclaw";
const CLAUDE_CHANNEL_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
] as const;

export type ClaudeLocalSessionSetup = {
  /** Socket (named pipe on Windows) the channel server and hooks connect to. */
  bridgeEndpoint: string;
  channelServerPath: string;
  hookScriptPath: string;
  /** `mcpServers` entry for `.mcp.json` or `~/.claude.json`. */
  mcpServerEntry: { command: string; args: string[] };
  /** `hooks` entry for `~/.claude/settings.json` (or a project `.claude/settings.json`). */
  hooksEntry: Record<string, Array<{ hooks: Array<{ type: "command"; command: string }> }>>;
  commands: { addMcpServer: string; launchClaude: string };
};

/** Resolve a shipped channel artifact next to this module (source tree or dist). */
export function resolveClaudeChannelArtifact(fileName: string): string {
  return fileURLToPath(new URL(`./claude-channel/${fileName}`, import.meta.url));
}

export function describeClaudeLocalSessionSetup(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeLocalSessionSetup {
  const channelServerPath = resolveClaudeChannelArtifact("openclaw-channel-server.mjs");
  const hookScriptPath = resolveClaudeChannelArtifact("openclaw-channel-hook.mjs");
  const hookCommand = `node ${JSON.stringify(hookScriptPath)}`;
  return {
    bridgeEndpoint: resolveClaudeChannelBridgeEndpoint(env),
    channelServerPath,
    hookScriptPath,
    mcpServerEntry: { command: "node", args: [channelServerPath] },
    hooksEntry: Object.fromEntries(
      CLAUDE_CHANNEL_HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "command" as const, command: hookCommand }] }],
      ]),
    ),
    commands: {
      addMcpServer: `claude mcp add --scope user ${CLAUDE_CHANNEL_SERVER_NAME} -- node ${JSON.stringify(channelServerPath)}`,
      launchClaude: `claude --dangerously-load-development-channels server:${CLAUDE_CHANNEL_SERVER_NAME}`,
    },
  };
}
