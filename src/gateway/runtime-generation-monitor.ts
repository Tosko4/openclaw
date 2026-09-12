import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON } from "../infra/gateway-fresh-process-restart.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { scheduleGatewaySigusr1Restart } from "../infra/restart.js";
import { resolveRuntimeServiceBuildId } from "../version.js";

const DEFAULT_RUNTIME_GENERATION_POLL_MS = 5_000;
const gatewayInstallRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });

type RuntimeGenerationLogger = {
  info(message: string): void;
  warn(message: string): void;
};

async function readRuntimeBuildId(buildInfoPath: string): Promise<string | null> {
  try {
    // SAFETY: the parsed value is treated as unknown except for the optional field check below.
    const parsed = JSON.parse(await readFile(buildInfoPath, "utf8")) as { buildId?: unknown };
    const buildId = normalizeOptionalString(parsed.buildId);
    return buildId && buildId.length <= 96 ? buildId : null;
  } catch {
    // Missing, partial, and invalid files are expected while a build is in progress.
    return null;
  }
}

export function startGatewayRuntimeGenerationMonitor(params: {
  log: RuntimeGenerationLogger;
  intervalMs?: number;
  installRoot?: string | null;
  loadedBuildId?: string | null;
  readBuildId?: (buildInfoPath: string) => Promise<string | null>;
  scheduleRestart?: typeof scheduleGatewaySigusr1Restart;
}): { stop(): Promise<void> } | null {
  const installRoot = params.installRoot ?? gatewayInstallRoot;
  const loadedBuildId = params.loadedBuildId ?? resolveRuntimeServiceBuildId();
  if (!installRoot || !loadedBuildId) {
    return null;
  }

  const buildInfoPath = path.join(installRoot, "dist", "build-info.json");
  const readBuildId = params.readBuildId ?? readRuntimeBuildId;
  const scheduleRestart = params.scheduleRestart ?? scheduleGatewaySigusr1Restart;
  let stopped = false;
  let restartScheduled = false;
  let inFlight: Promise<void> | null = null;

  const check = async () => {
    const currentBuildId = await readBuildId(buildInfoPath);
    if (stopped || restartScheduled || !currentBuildId || currentBuildId === loadedBuildId) {
      return;
    }
    restartScheduled = true;
    clearInterval(timer);
    params.log.info(
      `runtime generation changed (${loadedBuildId} -> ${currentBuildId}); scheduling fresh-process restart`,
    );
    const result = scheduleRestart({
      delayMs: 0,
      reason: GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON,
      skipCooldown: true,
    });
    if (!result.ok) {
      params.log.warn("runtime generation restart request was rejected");
    }
  };
  const poll = () => {
    if (stopped || restartScheduled || inFlight) {
      return;
    }
    inFlight = check().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(poll, params.intervalMs ?? DEFAULT_RUNTIME_GENERATION_POLL_MS);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
