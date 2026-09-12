import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";

let registered;
let child;
let stopPromise;
function readStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function persist(record) {
  fs.writeFileSync(record.ownerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
export function registerLiveGateway(gateway, root) {
  if (process.platform !== "linux" || !gateway.pid || registered)
    throw new Error("Live cleanup requires one owned Linux Gateway");
  child = gateway;
  registered = {
    pid: gateway.pid,
    root,
    startTicks: readStartTicks(gateway.pid),
    ownerPath: path.resolve(process.env.OPENCLAW_PERF_OWNER_PATH),
    stopped: false,
  };
  if (!registered.startTicks) throw new Error("Could not bind owned Gateway process identity");
  persist(registered);
}
async function stopRecord(record, processHandle) {
  if (
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 1 ||
    !/^\d+$/.test(record.startTicks ?? "")
  )
    throw new Error("Invalid owned Gateway identity");
  const currentStart = readStartTicks(record.pid);
  if (currentStart && currentStart !== record.startTicks)
    throw new Error("Gateway PID identity changed; refusing to signal");
  const handle = processHandle ?? {
    pid: record.pid,
    kill: (signal) => process.kill(record.pid, signal),
  };
  const inspect = () => inspectManagedProcessGroup(handle, { errorPolicy: "indeterminate" });
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (inspect() === "dead") break;
    if (inspect() === "indeterminate") throw new Error("Owned Gateway group state is uncertain");
    const identity = readStartTicks(record.pid);
    if (identity && identity !== record.startTicks)
      throw new Error("Gateway PID identity changed before cleanup");
    terminateManagedChild(handle, signal, {
      processGroupFallback: "never",
      onProcessGroupSignalError: (error) => {
        throw error;
      },
    });
    await waitForManagedProcessGroupExit(handle, 5000, {
      errorPolicy: "indeterminate",
      pollIntervalMs: 25,
    });
  }
  if (inspect() !== "dead")
    throw new Error(
      "Owned Gateway group remains live or uncertain; preserve fixture and stop lease",
    );
  record.stopped = true;
  record.stoppedAt = new Date().toISOString();
  persist(record);
}
export function ensureLiveGatewayStopped() {
  if (!registered) return Promise.resolve();
  return (stopPromise ??= stopRecord(registered, child));
}
export function assertLiveGatewayStopped() {
  if (
    registered &&
    (!registered.stopped ||
      inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }) !== "dead")
  ) {
    throw new Error(`Gateway shutdown unconfirmed; fixture preserved at ${registered.root}`);
  }
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  process.once(signal, () => {
    ensureLiveGatewayStopped()
      .catch((error) => console.error(error.message))
      .finally(() => process.exit(code));
  });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ownerPath = process.argv[2];
  if (ownerPath && fs.existsSync(ownerPath)) {
    const record = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    await stopRecord(record);
    console.log(
      JSON.stringify({
        cleanup: "owned-gateway-group-dead",
        pid: record.pid,
        stoppedAt: record.stoppedAt,
      }),
    );
  }
}
