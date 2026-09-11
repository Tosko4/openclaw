# Local session mirroring: partial repair and remaining live proof

Branch: `claude/local-session-mirror-e2e`, base `d62d5a3556a`.
No commits, pushes, or live deployment changes were made. Changes are in the working tree.

## Confirmed discovery blocker

The investigation's new CLI transcripts carry `entrypoint: "claude-desktop"`.
The inherited environment has `CLAUDE_CODE_ENTRYPOINT=claude-desktop`. Five recent
investigation transcripts checked by ID were absent from `listClaudeSessions`.
The scanner accepted only `cli`/`sdk-cli`; desktop metadata was the other route
into the catalog. CLI sessions launched from Desktop's environment have the tag
but lack that metadata. Thus a lifecycle hook could mark the thread live and the
source would still have no catalog entry to admit.

This establishes a discovery blocker, not a complete diagnosis of hook delivery
or process pairing. Those boundaries remain unproved on a real Claude process.

## Changes

- `extensions/anthropic/session-catalog-discovery.ts`: the catalog parses known
  Claude Desktop transcript records, while only a live source's explicit
  `liveThreadIds` can admit otherwise unlisted desktop-tagged transcripts.
  Normal catalog behavior continues to require Desktop metadata for those
  records. Live decisions are kept outside the scan/overlay result cache;
  dormant history and sidechains remain excluded.
- `extensions/anthropic/local-session-source.runtime.ts`: passes lifecycle-proven
  IDs to the catalog and logs bridge readiness, liveness, admission, missing
  catalog records, and publish/scan failures through the console-capable logger.
- `extensions/anthropic/local-session-bridge.ts`: logs pairing, unpairing, and
  unmatched hook/channel identities. Pairing rules are unchanged.
- `extensions/anthropic/claude-channel/openclaw-channel-hook.mjs`: reports malformed
  input, ancestry lookup failure, bridge timeout, and socket delivery errors on
  stderr; hooks still exit zero. Diagnostics do not echo prompt payloads.
- `src/gateway/local-sessions/bridge.runtime.ts`: stored rows use current node and
  source connectivity. An ended thread or disconnected source on an online
  device no longer claims the device is offline. No persistence changes.
- Regression tests and troubleshooting docs accompany these changes.

## Proof recorded

All executable commands used Node 26.8.2 from the supplied pnpm runtime path.
The relevant launcher is `node scripts/run-vitest.mjs`.

- Catalog regression: fails on the original implementation with an empty result;
  passes after the fix. Covers live desktop-tagged discovery, dormant/sidechain
  exclusion, and mutable-live-set/cache isolation.
- Hook regressions: both fail on the original script due to missing diagnostics;
  pass after the fix. Check zero exit status, empty stdout, useful stderr, and
  no echoed private input.
- Gateway lifecycle regression: original code fails after a closed frame with
  `connected:false` / `device is offline`; fixed code passes closed-thread,
  disconnected-source, and actually-offline-device transitions. No real sockets
  or persistent state are used in this test.
- Full catalog + hook files: **71 passed, 4 failed**. A full catalog rerun with
  the original production file fails the same four existing tests, plus the
  new discovery regression (**68 passed, 5 failed**). The four baseline failures
  all expect a quiescent filesystem watcher/cache:
  - imports a Claude Desktop custom group for its matching catalog row;
  - serves an unchanged assembled scan without reparsing transcript files;
  - re-stats only the changed project directory on the next poll;
  - keeps the CLI records when only the Desktop store changes.
- The source admission regression was attempted but cannot create its Unix
  socket: `listen EPERM`. Its behavior is **not verified** here.
- Independent peer review found no blocking issues in the discovery/source/
  diagnostics changes. The required autoreview helper failed to reach its
  backend and timed out (status `reviewer_unavailable`, no verdict).

- `pnpm build`: passed, including plugin artifacts, SDK declarations, and UI
  assets (4m20s). The UI build printed an advisory startup-JS gzip overage
  (345.5 KiB versus 344.8 KiB); no UI baseline was changed.
- Executed the built hook artifact against a missing isolated endpoint: exit
  zero, visible ancestry/delivery diagnostics with `ENOENT`, no prompt echo.
- MDX validation passed for all three touched Markdown files. Internal link
  audit checked 13,431 links with zero broken links. `git diff --check` passed.
- Final focused regression run: **4 passed** across the catalog, hook, and Gateway
  test files. See `final-regressions.log`.
- Core, core-test, extension, and extension-test typechecks passed. The changed
  check also passed format, plugin boundaries, doctor contract tests, and its
  other preceding guards, then failed the dead-export scan on the unchanged
  `resolveClaudeChannelArtifact` export in `local-session-setup.ts`. At the base
  commit its only external callers are already tests; no production consumer
  was removed by this change. This aggregate check is **not green**.
- The remaining native-schema, database-first, media, sidecar, import-cycle,
  webhook, and pairing guards were run separately and passed.
- Targeted core lint passed after using the repository's deferred helper and
  omitting its redundant default type argument.
- Extension lint is blocked by its declaration-input boundary guard: resolution
  reaches the ancestor checkout's `node_modules/.../qrcode/package.json`. The
  guard requires a separate physical checkout outside an ancestor install;
  repeating installation here does not resolve it. The ancestor install was
  left untouched. No lint skip or boundary exception was added.

Task-only evidence is in `.artifacts/mirror-e2e/` (ignored):
`baseline-vitest.log`, `fixed-vitest.log`, `original-catalog-vitest.log`,
`source-vitest.log`, `changed-checks.log`, `build.log`, and `autoreview.log`.
Additional runs are in `final-regressions.log`, `core-lint.log`, and
`remaining-checks.log`.
The file-only `catalog-regression.mts` also demonstrated red/green behavior.
No transcript text or credentials were copied into these proof scripts.

## Host restrictions and unproved outcomes

The current sandbox denies Unix and loopback TCP socket listeners (`EPERM`),
and denies `ps`. Therefore no isolated Gateway/node or real Claude input
roundtrip could be run. Automatic appearance, live `canInput: true`, receipt of
team input by Claude, and the echoed transcript remain unproved. Do not treat
this branch as ready to deploy based on the file-based regression alone.

Git staging also failed with:

```text
Unable to create '/Users/scottfan/Desktop/openclaw/.git/worktrees/mirror-e2e/index.lock': Operation not permitted
```

The worktree's shared Git metadata is outside this session's writable roots.
Approval escalation is unavailable. No alternate Git store or permission
workaround was used, and no commit was created.

## Next concrete step

Continue in this worktree from a session permitted to bind local sockets,
inspect its own process ancestry, and write its shared Git metadata. Keep the
live Gateway, `~/.openclaw`, live worktree, and launchd node untouched.

1. Put the supplied Node 26 binary directory first on PATH. Run the pending
   source/channel tests:

   ```sh
   node scripts/run-vitest.mjs extensions/anthropic/local-session-source.test.ts extensions/anthropic/local-session-bridge.test.ts extensions/anthropic/local-session-channel-server.test.ts
   ```

2. Create two fresh short state directories under `/tmp`, one for Gateway and
   one for node. Use a spare port (for example 28789 after checking it is free)
   and an obviously synthetic shared test token. In separate terminals run:

   ```sh
   OPENCLAW_STATE_DIR=<gateway-state> OPENCLAW_GATEWAY_TOKEN=<test-token> pnpm openclaw gateway run --port 28789 --bind loopback --auth token --allow-unconfigured --verbose
   OPENCLAW_STATE_DIR=<node-state> OPENCLAW_GATEWAY_TOKEN=<test-token> CLAUDE_CONFIG_DIR="$HOME/.claude" pnpm openclaw node run --host 127.0.0.1 --port 28789 --no-tls --display-name mirror-e2e
   ```

3. Use `devices list` / `devices approve` against the explicit isolated URL if
   device pairing is pending. Read `node.list` to obtain the isolated node's
   device identity. Enroll source `claude` into agent `main`:

   ```sh
   OPENCLAW_STATE_DIR=<gateway-state> pnpm openclaw gateway call sessions.local.enroll --url ws://127.0.0.1:28789 --token <test-token> --json --params '{"deviceId":"<isolated-device-id>","sourceId":"claude","agentId":"main"}'
   OPENCLAW_STATE_DIR=<node-state> pnpm openclaw sessions share --json
   OPENCLAW_STATE_DIR=<node-state> pnpm openclaw sessions share --accept <enrollment-id> --json
   ```

   Manual acceptance avoids the automatic setup path that writes user Claude
   settings. Configure this test Claude invocation to use this worktree's built
   hook/channel artifacts via per-invocation `--settings`, `--mcp-config`, and
   `--strict-mcp-config`; do not rewrite the live global hooks. Check the CLI's
   `--setting-sources` option to exclude unrelated inherited hooks if needed.

4. Start a genuinely new interactive Claude session in a task-owned directory,
   using `OPENCLAW_STATE_DIR=<node-state>` and the channel launch flag. Always
   clear the inherited provider overrides as instructed:

   ```sh
   env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY OPENCLAW_STATE_DIR=<node-state> claude --dangerously-load-development-channels server:openclaw
   ```

   Keep `CLAUDE_CODE_ENTRYPOINT=claude-desktop` for the first proof so it exercises
   the reproduced defect. Observe `observed live`, `paired`, and `admitted`
   diagnostics; if pairing fails, compare channel `parentPid` with hook ancestry.
   Do not replace process identity with ambiguous working-directory pairing.

5. Read `sessions.list` on the isolated Gateway. Require the new thread to
   appear automatically with `localSession.canInput: true`. Send a unique marker
   through `chat.send` with `sessionKey`, `message`, a fresh `idempotencyKey`, and
   `queueMode: "followup"`. Verify the marker in the local Claude process and its
   transcript, then the mirrored response. A bridge write/`submitted` receipt
   alone is not evidence that Claude consumed the message. Close that Claude
   session and verify the Gateway reports session unavailability while the node
   stays online.

6. Resolve the unchanged unused-export finding and obtain extension lint proof
   in the physical checkout layout required by its guard. Rerun the necessary
   checks and autoreview, then commit
   without pushing. Suggested coherent commits:
   - `fix(anthropic): discover live desktop-tagged Claude sessions`
   - `fix(sessions): distinguish unavailable threads from offline devices`
     Include the hook diagnostics and related tests/docs with the first commit;
     include the Gateway status test/docs with the second. Update this handoff with
     the actual live evidence before deployment.

Only task-created scratch/proof directories exist under `/tmp/oc-mirror-e2e*`.
No Gateway, node host, or Claude session was left running by this task.
