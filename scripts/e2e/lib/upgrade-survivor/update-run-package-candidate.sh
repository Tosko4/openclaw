#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh

[ "${OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF:-0}" = 1 ] || exit 2
baseline="${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC:?missing exact baseline}"
artifact_dir="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR:?missing artifact directory}"
candidate="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing candidate tarball}"
proof_script=/app/scripts/e2e/lib/upgrade-survivor/update-run-package-candidate.mjs
registry_pid="" mock_pid=""
cleanup() {
  local status="$?"
  trap - EXIT
  # Only teardown may stop the service. The scenario never starts/restarts it
  # after update.run: the installed updater owns replacement and readiness.
  systemctl --user stop openclaw-gateway.service >/dev/null 2>&1 || true
  openclaw_e2e_stop_process "$mock_pid"
  openclaw_e2e_stop_process "$registry_pid"
  exit "$status"
}
trap cleanup EXIT

export CI=true OPENCLAW_NO_ONBOARD=1 OPENCLAW_NO_PROMPT=1 OPENCLAW_SKIP_PROVIDERS=1
export npm_config_prefix=/tmp/openclaw-managed-candidate/npm-prefix
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache=/tmp/openclaw-managed-candidate/npm-cache
export NPM_CONFIG_CACHE="$npm_config_cache"
export PATH="$npm_config_prefix/bin:$PATH"
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$artifact_dir/systemctl.log"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$artifact_dir/systemctl.pid"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$artifact_dir/gateway.log"
mkdir -p "$artifact_dir" "$OPENCLAW_STATE_DIR" "$npm_config_prefix" "$npm_config_cache"

tar -xOf "$candidate" package/package.json >"$artifact_dir/candidate-package.json"
tar -xOf "$candidate" package/dist/build-info.json >"$artifact_dir/candidate-build-info.json"
candidate_version="$(node -p 'require(process.argv[1]).version' "$artifact_dir/candidate-package.json")"
node "$proof_script" inputs "$baseline" "$candidate" "$artifact_dir"
npm install -g --prefix "$npm_config_prefix" "$baseline" --no-fund --no-audit \
  >"$artifact_dir/baseline-install.log" 2>&1
cp "$npm_config_prefix/lib/node_modules/openclaw/package.json" "$artifact_dir/baseline-package.json"
cp "$npm_config_prefix/lib/node_modules/openclaw/dist/build-info.json" "$artifact_dir/baseline-build-info.json"
node "$proof_script" baseline "$baseline" "$artifact_dir"

# Baseline selection stays upstream until installed. The ordinary npm registry
# now exposes the exact candidate bytes to the old updater, never a repack.
OPENCLAW_NPM_REGISTRY_UPSTREAM="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org}" \
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="" \
  openclaw_prepublish_plugin_registry_start \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" \
    "${OPENCLAW_DOCKER_E2E_SELECTED_SHA:-}" "$candidate_version" \
    "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256:-}" \
    /tmp/openclaw-managed-candidate/registry registry_pid openclaw "$candidate_version" "$candidate"
install_update_restart_systemctl_shim
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf '[ "$#" = 7 ] && [ "$1" = --user ] && [ "$2" = --scope ] && [ "$3" = --collect ] || exit 2\n'
  printf '[[ "$4" == --unit=openclaw-update-*.scope ]] || exit 2\n'
  printf 'node %q scope "$$" "$7" %q\n' "$proof_script" "$artifact_dir/scope.json"
  printf 'exec "${@:5}"\n'
} >"$npm_config_prefix/bin/systemd-run"
chmod +x "$npm_config_prefix/bin/systemd-run"

node "$proof_script" config "$OPENCLAW_CONFIG_PATH"
openclaw_e2e_start_mock_openai 44212 mock_pid
openclaw gateway install --force --json >"$artifact_dir/service-install.json" 2>"$artifact_dir/service-install.err"
openclaw_e2e_wait_gateway_ready "$(cat "$artifact_dir/systemctl.pid")" "$artifact_dir/gateway.log" 360 18791
node "$proof_script" run "$artifact_dir" "$npm_config_prefix/lib/node_modules/openclaw"
