#!/usr/bin/env bash
set -euo pipefail
if [[ $(uname -s) != Linux ]]; then echo 'Live allocation proof requires Linux process-group ownership' >&2; exit 1; fi
label=${1:?Supply a unique baseline or candidate label}
if [[ ! $label =~ ^[a-z0-9-]+$ ]]; then echo 'Invalid evidence label' >&2; exit 1; fi
test "$(git remote get-url origin)" = https://github.com/openclaw/openclaw.git
test -z "$(git status --porcelain --untracked-files=no)"
carrier_sha=$(git rev-parse HEAD)
source_tree=$(git rev-parse 'HEAD^{tree}')
output_dir="/tmp/openclaw-memory-evidence/$label"
test ! -e "$output_dir"
mkdir -p "$output_dir"
chmod 700 "$output_dir"
export OPENCLAW_PERF_OWNER_PATH="$output_dir/gateway-owner.json"
export OPENCLAW_PERF_HTTP_COUNTS_PATH="$output_dir/http-counts.json"
export OPENCLAW_PERF_PROFILE_DIR="$output_dir/profiles"
cleanup_owned_gateway() {
  local original_status=$?
  trap - EXIT INT TERM
  node qa/.gateway-memory-live/live-cleanup.mjs "$OPENCLAW_PERF_OWNER_PATH" || {
    test "$original_status" -ne 0 || original_status=1
  }
  exit "$original_status"
}
trap cleanup_owned_gateway EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v openclaw-testbox-env >/dev/null
node qa/.gateway-memory-live/verify-source.mjs > "$output_dir/source-proof.json"
sha256sum qa/.gateway-memory-live/* > "$output_dir/harness.sha256"
node --version > "$output_dir/node-version.txt"
pnpm --version > "$output_dir/pnpm-version.txt"
git show -s --format=fuller HEAD > "$output_dir/carrier.txt"
printf 'LIVE_MEMORY_EVIDENCE=%s\n' "$output_dir"
printf 'LIVE_MEMORY_BUILD_STARTED\n'
pnpm exec node --import ./scripts/tsx.mjs scripts/build-all.mts sourcePerformance > "$output_dir/build.log" 2>&1
printf 'LIVE_MEMORY_BUILD_COMPLETE\n'
started_at=$(date -u +%FT%TZ)
set +e
timeout --signal=INT --kill-after=30s 30m openclaw-testbox-env node qa/.gateway-memory-live/live-bench.ts \
  --session-count 1000 --concurrency 8 --session-updates 100 --session-update-clients 4 \
  --history-clients 4 --history-burst 3 --probe-rounds 100 --subscribers 4 --control-plane --visible-observer \
  --no-diagnostics-timeline --timeout-ms 300000 --output "$output_dir/live-openai-1000.json" \
  > "$output_dir/benchmark.log" 2>&1
run_status=$?
set -e
finished_at=$(date -u +%FT%TZ)
printf '{"label":"%s","startedAt":"%s","finishedAt":"%s","exitCode":%s,"carrierSha":"%s","sourceTree":"%s"}\n' "$label" "$started_at" "$finished_at" "$run_status" "$carrier_sha" "$source_tree" > "$output_dir/run-meta.json"
sha256sum -c "$output_dir/harness.sha256" >/dev/null
test "$(git rev-parse HEAD)" = "$carrier_sha"
test "$(git rev-parse 'HEAD^{tree}')" = "$source_tree"
test -z "$(git status --porcelain --untracked-files=no)"
if test -f "$output_dir/live-openai-1000.json"; then
  node qa/.gateway-memory-live/summarize.mjs "$output_dir/live-openai-1000.json"
else
  echo 'Live proof failed; preserve the private benchmark log for diagnosis' >&2
fi
exit "$run_status"
