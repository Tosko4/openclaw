#!/usr/bin/env bash
set -euo pipefail
label=${1:?Supply a unique paired evidence label}
baseline_sha=${2:?Supply the reviewed exact baseline commit}
[[ "$label" =~ ^[a-z0-9-]+$ ]]
[[ "$baseline_sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git remote get-url origin)" = https://github.com/openclaw/openclaw.git
candidate_root=$PWD
baseline_root="/tmp/openclaw-memory20-baseline-$label"
test ! -e "$baseline_root"
test ! -e "/tmp/openclaw-memory-evidence/$label-baseline"
test ! -e "/tmp/openclaw-memory-evidence/$label-candidate"
test -z "$(git status --porcelain --untracked-files=no)"
node qa/.gateway-memory-live/verify-source.mjs >/dev/null
if ! git cat-file -e "$baseline_sha^{commit}" 2>/dev/null; then
  git fetch --no-tags origin "$baseline_sha"
fi
git worktree add --detach "$baseline_root" "$baseline_sha"
cp -a qa/.gateway-memory-live "$baseline_root/qa/.gateway-memory-live"
export OPENCLAW_PERF_TOOL_FLOW=1
export OPENCLAW_PERF_SUPPORTED_CLEANUP=0
(
  cd "$baseline_root"
  pnpm install --frozen-lockfile
  node qa/.gateway-memory-live/prepare.mjs
  node qa/.gateway-memory-live/bind-source.mjs
  node qa/.gateway-memory-live/verify-source.mjs >/dev/null
  bash qa/.gateway-memory-live/run-live.sh "$label-baseline"
)
cd "$candidate_root"
bash qa/.gateway-memory-live/run-live.sh "$label-candidate"
printf 'LIVE_MEMORY_ALLOCATION_PAIR_COMPLETE=%s\n' "$label"
