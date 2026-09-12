import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON } from "../infra/gateway-fresh-process-restart.js";
import { startGatewayRuntimeGenerationMonitor } from "./runtime-generation-monitor.js";

function createScheduledRestart() {
  return {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1" as const,
    delayMs: 0,
    reason: GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  };
}

describe("startGatewayRuntimeGenerationMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start without immutable loaded build provenance", () => {
    expect(
      startGatewayRuntimeGenerationMonitor({
        log: { info: vi.fn(), warn: vi.fn() },
        installRoot: "/openclaw",
        loadedBuildId: null,
      }),
    ).toBeNull();
  });

  it("ignores incomplete builds and schedules one restart for a completed new generation", async () => {
    vi.useFakeTimers();
    const readBuildId = vi
      .fn<(buildInfoPath: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("build-a")
      .mockResolvedValue("build-b");
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const log = { info: vi.fn(), warn: vi.fn() };
    const monitor = startGatewayRuntimeGenerationMonitor({
      log,
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readBuildId,
      scheduleRestart,
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(readBuildId).toHaveBeenCalledWith("/openclaw/dist/build-info.json");
    expect(scheduleRestart).toHaveBeenCalledExactlyOnceWith({
      delayMs: 0,
      reason: GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON,
      skipCooldown: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      "runtime generation changed (build-a -> build-b); scheduling fresh-process restart",
    );

    await vi.advanceTimersByTimeAsync(400);
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    await monitor?.stop();
  });

  it("does not schedule after stop while a read is in flight", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: string | null) => void) | undefined;
    const readBuildId = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const monitor = startGatewayRuntimeGenerationMonitor({
      log: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readBuildId,
      scheduleRestart,
    });

    await vi.advanceTimersByTimeAsync(100);
    const stopped = monitor?.stop();
    resolveRead?.("build-b");
    await stopped;

    expect(scheduleRestart).not.toHaveBeenCalled();
  });
});
