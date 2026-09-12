import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const safeNames = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "WebSocket",
  "WebSocketServer",
  "Socket",
  "TLSSocket",
  "Server",
  "Timeout",
  "Immediate",
  "Buffer",
  "ArrayBuffer",
  "Uint8Array",
  "Function",
  "SessionManager",
  "Session",
  "DatabaseSync",
  "StatementSync",
  "AbortController",
  "AbortSignal",
  "EventEmitter",
  "Headers",
  "Request",
  "Response",
  "URL",
  "URLSearchParams",
  "IncomingMessage",
  "ClientRequest",
  "Agent",
  "system / Context",
  "system / NativeContext",
]);
const safeProperties = new Set([
  "context",
  "previous",
  "next",
  "data",
  "value",
  "values",
  "key",
  "keys",
  "entries",
  "table",
  "store",
  "cache",
  "sessions",
  "session",
  "clients",
  "client",
  "socket",
  "sockets",
  "server",
  "_events",
  "_eventsCount",
  "_socket",
  "_server",
  "_onTimeout",
  "_idleNext",
  "_idlePrev",
  "callback",
  "listener",
  "listeners",
  "resolve",
  "reject",
  "promise",
  "config",
  "state",
  "metadata",
  "result",
  "controller",
  "signal",
  "request",
  "response",
  "pending",
  "buffer",
  "buffers",
  "constructor",
  "prototype",
  "__proto__",
  "native_context",
  "sloppy_function_map",
  "properties",
  "elements",
]);
const checkpoints = JSON.parse(fs.readFileSync(path.join(dir, "snapshot-summary.json"), "utf8"));
let baselineIds;
const result = [];
for (const checkpoint of checkpoints) {
  const h = JSON.parse(fs.readFileSync(checkpoint.snapshotPath, "utf8"));
  const nf = h.snapshot.meta.node_fields,
    ef = h.snapshot.meta.edge_fields;
  const nlen = nf.length,
    elen = ef.length,
    count = h.nodes.length / nlen;
  const ni = {
    type: nf.indexOf("type"),
    name: nf.indexOf("name"),
    id: nf.indexOf("id"),
    size: nf.indexOf("self_size"),
    edges: nf.indexOf("edge_count"),
  };
  const ei = {
    type: ef.indexOf("type"),
    name: ef.indexOf("name_or_index"),
    target: ef.indexOf("to_node"),
  };
  const nt = h.snapshot.meta.node_types[ni.type],
    et = h.snapshot.meta.edge_types[ei.type];
  const family = (i) => {
    const o = i * nlen,
      t = nt[h.nodes[o + ni.type]],
      n = h.strings[h.nodes[o + ni.name]];
    return t + (safeNames.has(n) ? ":" + n : "");
  };
  const starts = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) starts[i + 1] = starts[i] + h.nodes[i * nlen + ni.edges] * elen;
  const parent = new Int32Array(count).fill(-1),
    parentEdge = new Int32Array(count).fill(-1),
    queue = new Uint32Array(count);
  let first = 0,
    last = 1;
  queue[0] = 0;
  parent[0] = 0;
  while (first < last) {
    const source = queue[first++];
    for (let e = starts[source]; e < starts[source + 1]; e += elen) {
      if (et[h.edges[e + ei.type]] === "weak") continue;
      const target = h.edges[e + ei.target] / nlen;
      if (parent[target] !== -1) continue;
      parent[target] = source;
      parentEdge[target] = e;
      queue[last++] = target;
    }
  }
  const pathFor = (i) => {
    const p = [];
    for (let depth = 0; i !== 0 && depth < 18; depth++) {
      const e = parentEdge[i];
      if (e < 0) {
        p.push({ node: family(i), edge: "unreachable-by-strong-root-walk" });
        break;
      }
      const t = et[h.edges[e + ei.type]],
        raw = h.edges[e + ei.name],
        name = t === "element" || t === "hidden" ? "<index>" : h.strings[raw];
      p.push({
        node: family(i),
        edge: t + ":" + (safeProperties.has(name) ? name : "<redacted-name>"),
      });
      i = parent[i];
    }
    return p.reverse();
  };
  const groups = new Map(),
    ids = new Set();
  for (let i = 0; i < count; i++) {
    const o = i * nlen,
      id = h.nodes[o + ni.id],
      f = family(i),
      size = h.nodes[o + ni.size];
    ids.add(id);
    let g = groups.get(f);
    if (!g) {
      g = { family: f, count: 0, selfBytes: 0, newCount: 0, newSelfBytes: 0, examples: [] };
      groups.set(f, g);
    }
    g.count++;
    g.selfBytes += size;
    if (baselineIds && !baselineIds.has(id)) {
      g.newCount++;
      g.newSelfBytes += size;
      if (g.examples.length < 2 && f.startsWith("object:"))
        g.examples.push({ id, selfBytes: size, strongRootPath: pathFor(i) });
    }
  }
  if (!baselineIds) baselineIds = ids;
  result.push({
    phase: checkpoint.phase,
    pid: checkpoint.pid,
    postGcMemory: checkpoint.memory,
    snapshotDurationMs: checkpoint.durationMs,
    nodeCount: count,
    strongRootReachable: last,
    totalSelfBytes: [...groups.values()].reduce((a, g) => a + g.selfBytes, 0),
    families: [...groups.values()].sort((a, b) => b.selfBytes - a.selfBytes),
  });
}
const output = {
  privacy:
    "No captured string values, arbitrary constructor/function/property names, or snapshot data emitted. Paths use fixed structural-name allowlists.",
  limitation:
    "Strong root paths show one shortest retaining path, not dominators. Family deltas alone are not leak proof. Objects created after baseline are tracked by stable same-PID snapshot IDs.",
  checkpoints: result,
};
fs.writeFileSync(path.join(dir, "structural-summary.json"), JSON.stringify(output, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    result.map((r) => ({
      phase: r.phase,
      pid: r.pid,
      memory: r.postGcMemory,
      topFamilies: r.families.slice(0, 12).map(({ examples, ...g }) => g),
    })),
    null,
    2,
  ),
);
