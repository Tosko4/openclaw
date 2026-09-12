import fs from "node:fs";
import path from "node:path";
import {
  controlGatewayHeapProfile,
  readGatewayHeapProfile,
} from "../../scripts/lib/gateway-bench-heap.ts";
const collectorBinding = JSON.parse(
  fs.readFileSync(new URL("./adapter-source.json", import.meta.url), "utf8"),
).heapCollector;

export async function connectAllocationProfiler(port, outputDir, child) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const endpoint = targets[0]?.webSocketDebuggerUrl;
  if (!endpoint?.startsWith(`ws://127.0.0.1:${port}/`))
    throw new Error("Owned inspector endpoint unavailable");
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;
  let snapshotFd;
  const snapshots = [];
  const rejectPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Owned inspector connection closed"));
    }
    pending.clear();
  };
  socket.addEventListener("close", rejectPending);
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.method === "HeapProfiler.addHeapSnapshotChunk" && snapshotFd !== undefined) {
      fs.writeSync(snapshotFd, frame.params.chunk);
      return;
    }
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
    else waiter.resolve(frame.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Inspector timeout: ${method}`));
      }, 300000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const memory = async () => {
    const result = await request("Runtime.evaluate", {
      expression:
        "({memory:process.memoryUsage(),resource:process.resourceUsage(),uptime:process.uptime()})",
      returnByValue: true,
    });
    if (result.exceptionDetails || !result.result?.value?.memory)
      throw new Error("Gateway memory snapshot unavailable");
    return result.result.value;
  };
  await request("HeapProfiler.enable");
  await request("Profiler.enable");
  await request("Profiler.setSamplingInterval", { interval: 1000 });
  const phases = {};
  let active;
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    async snapshot(phase) {
      if (active) throw new Error("Snapshot overlaps timed allocation phase");
      await request("HeapProfiler.collectGarbage");
      const before = await memory();
      const snapshotPath = path.join(outputDir, phase + "-" + child.pid + ".heapsnapshot");
      const started = performance.now();
      snapshotFd = fs.openSync(snapshotPath, "wx", 0o600);
      try {
        await request("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      } finally {
        fs.closeSync(snapshotFd);
        snapshotFd = undefined;
      }
      const record = {
        phase,
        pid: child.pid,
        memory: before.memory,
        snapshotPath,
        durationMs: performance.now() - started,
      };
      snapshots.push(record);
      fs.writeFileSync(
        path.join(outputDir, "snapshot-summary.json"),
        JSON.stringify(snapshots, null, 2),
        { mode: 0o600 },
      );
      console.error(JSON.stringify({ evidence: "heap-snapshot", ...record }));
      return record;
    },
    async start(phase) {
      if (active || phases[phase]) throw new Error("Overlapping or duplicate allocation phase");
      await request("HeapProfiler.collectGarbage");
      const beforeGc = await memory();
      await controlGatewayHeapProfile(child, "start", path.join(outputDir, `${phase}.heapprofile`));
      await request("Profiler.start");
      active = { phase, beforeGc, startedAt: new Date().toISOString() };
    },
    async stop() {
      if (!active) throw new Error("No active allocation phase");
      const { profile: cpu } = await request("Profiler.stop");
      const after = await memory();
      const profilePath = path.join(outputDir, `${active.phase}.heapprofile`);
      await controlGatewayHeapProfile(child, "stop", profilePath);
      const allocations = readGatewayHeapProfile(profilePath);
      await request("HeapProfiler.collectGarbage");
      const afterGc = await memory();
      const record = {
        ...active,
        finishedAt: new Date().toISOString(),
        after,
        afterGc,
        estimatedAllocatedBytes: allocations.sampledAllocatedBytes,
        retainedHeapGrowthBytes: afterGc.memory.heapUsed - active.beforeGc.memory.heapUsed,
        samplingInterval: allocations.samplingIntervalBytes,
        includesCollectedObjects: allocations.includesCollectedObjects,
        topAllocationStacks: allocations.topAllocationSites,
        collectorSource: { owner: collectorBinding.owner, helpers: collectorBinding.helpers },
        collectorCommit: collectorBinding.commit,
        note: "V8 main-isolate statistical allocation estimate, including objects collected during the phase; native and worker-isolate allocations are excluded. Forced GC snapshots are outside sampled phases.",
      };
      fs.writeFileSync(path.join(outputDir, `${active.phase}.cpuprofile`), JSON.stringify(cpu));
      phases[active.phase] = record;
      fs.writeFileSync(
        path.join(outputDir, "allocation-summary.json"),
        JSON.stringify(phases, null, 2),
      );
      active = undefined;
      return record;
    },
    close() {
      rejectPending();
      socket.close();
    },
  };
}
