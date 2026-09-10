// Diagnostic only. No credentials, prompt text, paths, or HMAC key leave this process.
import { createHmac, randomBytes } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import path from "node:path";

const REDACTED_SLOT = Symbol.for("openclaw.release.cliComponentRedacted");
// ESM consumers cannot replace this binding; only this module installs its raw sink.
export let observeCliComponentProbe;
const PLUGIN_FIELDS = {
  "anthropic-close": ["generation", "reason"],
  "anthropic-decision": [
    "fingerprint",
    "existingFingerprint",
    "generation",
    "hasExisting",
    "fingerprintsEqual",
    "sessionMapHasExisting",
    "reusable",
    "willRestart",
    "useResume",
  ],
  "anthropic-session": ["generation", "fingerprint", "reused", "closed", "hasCurrentTurn"],
};
const PLUGIN_HASH_FIELDS = new Set(["generation", "fingerprint", "existingFingerprint"]);
const MAX_EVENTS = 2048;
const MAX_BODIES = 256;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TARGET_BYTES = 1024 * 1024;
const MAX_TOTAL_TARGET_BYTES = 16 * 1024 * 1024;
const POST_DECISION_TARGET_AUDIT = false;
const REASONS = new Set([
  "watch",
  "watch-targets",
  "config",
  "manual",
  "plugin",
  "idle",
  "restart",
  "abort",
  "mcp-capture-rotation",
  "symlink",
  "copy",
]);

export function startCliComponentProbe() {
  if (observeCliComponentProbe || Object.hasOwn(globalThis, REDACTED_SLOT)) {
    throw new Error("CLI diagnostic observer already installed");
  }
  const key = randomBytes(32);
  const started = performance.now();
  const events = [];
  const bodies = new Map();
  const readyListeners = new Map();
  const pendingTargets = [];
  let sequence = 0,
    dropped = 0,
    failures = 0,
    outputBytes = 0,
    targetBytes = 0;
  let stopped = false;
  const digest = (value) =>
    createHmac("sha256", key)
      .update(
        Buffer.isBuffer(value)
          ? value
          : typeof value === "string"
            ? value
            : (JSON.stringify(value) ?? "<undefined>"),
      )
      .digest("hex");
  const identity = (value) => (typeof value === "string" ? digest(path.resolve(value)) : null);
  const entryDigest = (value) =>
    value === undefined ? { present: false } : { present: true, h: digest(value) };
  const safe = (value, field = "", depth = 0) => {
    if (value === undefined) {
      return { present: false };
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      return field === "reason" && REASONS.has(value) ? value : { h: digest(value) };
    }
    if (depth >= 5) {
      return { h: digest(value), opaque: true };
    }
    if (Array.isArray(value)) {
      return {
        count: value.length,
        items: value.slice(0, 128).map((item) => safe(item, "", depth + 1)),
        truncated: value.length > 128,
      };
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([name, item]) => [name, safe(item, name, depth + 1)]),
    );
  };
  const append = (event, data) => {
    if (stopped) {
      return;
    }
    const row = {
      seq: ++sequence,
      ms: Math.round((performance.now() - started) * 1000) / 1000,
      event,
      data,
    };
    const encoded = JSON.stringify(row);
    if (events.length >= MAX_EVENTS || outputBytes + encoded.length > MAX_OUTPUT_BYTES) {
      dropped++;
      return;
    }
    events.push(row);
    outputBytes += encoded.length;
  };
  const auditTargets = (targets, decisionSequence) => {
    if (stopped) {
      return;
    }
    const before = performance.now();
    for (const target of targets) {
      let fd;
      const info = {
        source: identity(target.source),
        target: identity(target.target),
        decisionSequence,
      };
      try {
        fd = openSync(target.target, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.size > MAX_TARGET_BYTES ||
          targetBytes + stat.size > MAX_TOTAL_TARGET_BYTES
        ) {
          append("target-audit", { ...info, status: "bounded-or-nonfile" });
          continue;
        }
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (!count) {
            break;
          }
          length += count;
        }
        targetBytes += length;
        if (length !== stat.size) {
          append("target-audit", { ...info, status: "changed-during-read" });
          continue;
        }
        append("target-audit", {
          ...info,
          status: "read",
          bytes: length,
          body: digest(bytes.subarray(0, length)),
        });
      } catch {
        append("target-audit", { ...info, status: "unreadable" });
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            failures++;
          }
        }
      }
    }
    append("target-audit-overhead", {
      decisionSequence,
      elapsedMs: performance.now() - before,
      count: targets.length,
    });
  };
  const observe = (event, data = {}) => {
    if (stopped) {
      return;
    }
    try {
      if (event === "skills-watch-created") {
        if (readyListeners.size >= MAX_EVENTS) {
          dropped++;
          return;
        }
        const { state } = data;
        const ready = () => {
          readyListeners.delete(state.watcher);
          observe("skills-watch-ready", data);
        };
        // Attach before the owner's ready handler; inactive probes add no listener.
        // Finish removes pending observers without touching the owner's callbacks.
        readyListeners.set(state.watcher, ready);
        state.watcher.once("ready", ready);
      } else if (event === "skills-watch-schedule") {
        append(
          event,
          safe({
            target: data.target.path,
            changedPath: data.changedPath,
            hadTimer: Boolean(data.state.timer),
            pendingPath: data.state.pendingPath,
          }),
        );
      } else if (event === "skills-watch-ready" || event === "skills-watch-fire") {
        append(
          event,
          safe({
            target: data.target.path,
            ...(event === "skills-watch-fire" ? { pendingPath: data.state.pendingPath } : {}),
            subscribers: Array.from(
              data.state.subscribers,
              (watcherKey) => data.owners.get(watcherKey) ?? watcherKey,
            ),
          }),
        );
      } else if (event === "skill-body") {
        const file = identity(data.filePath);
        const body = digest(data.content);
        if (bodies.has(file) || bodies.size < MAX_BODIES) {
          bodies.set(file, { body, observedSeq: sequence + 1 });
        } else {
          dropped++;
        }
        append(event, {
          file,
          body,
          bytes: Buffer.byteLength(data.content),
          name: entryDigest(data.name),
        });
      } else if (event === "fingerprint") {
        const snapshot = data.snapshot;
        const selected = (snapshot?.resolvedSkills ?? []).slice(0, MAX_BODIES).map((skill) => {
          const file = identity(skill.filePath);
          return {
            file,
            metadata: digest({
              name: skill.name,
              description: skill.description,
              filePath: skill.filePath,
              sourceInfo: skill.sourceInfo,
            }),
            loadedBody: bodies.get(file) ?? null,
          };
        });
        append(event, {
          fingerprint: digest(data.fingerprint),
          components: Object.fromEntries(
            Object.entries(data.input).map(([name, value]) => [name, entryDigest(value)]),
          ),
          argvItems: data.input.argv.map((value) => digest(value)),
          env: data.input.env.map(([name, value]) => ({ name, value: entryDigest(value) })),
          skillsVersion: snapshot?.version ?? null,
          skillsComponents: data.skillsInput
            ? Object.fromEntries(
                Object.entries(data.skillsInput).map(([name, value]) => [name, entryDigest(value)]),
              )
            : null,
          skillsExcludingVersion: data.skillsInput
            ? digest(
                Object.fromEntries(
                  Object.entries(data.skillsInput).filter(([name]) => name !== "version"),
                ),
              )
            : null,
          selectedCount: snapshot?.resolvedSkills?.length ?? 0,
          selected,
          normalization: safe(data.normalization),
          preparedMcpConfig: entryDigest(data.mcpConfigHash),
          preparedMcpResume: entryDigest(data.mcpResumeHash),
          owner: safe(data.owner),
        });
      } else if (event === "native-materialized") {
        append(event, safe(data));
        if (POST_DECISION_TARGET_AUDIT && pendingTargets.length < MAX_BODIES) {
          pendingTargets.push({
            source: path.join(data.sourceDir, "SKILL.md"),
            target: path.join(data.targetDir, "SKILL.md"),
          });
        }
      } else {
        append(event, safe(data));
      }
    } catch {
      failures++;
    }
  };
  const receiveRedacted = (event, data) => {
    if (stopped) {
      return;
    }
    try {
      const fields = PLUGIN_FIELDS[event];
      if (!fields || !data || typeof data !== "object") {
        throw new Error("Invalid diagnostic event");
      }
      const properties = Object.getOwnPropertyDescriptors(data);
      if (Reflect.ownKeys(properties).length !== fields.length) {
        throw new Error("Invalid fields");
      }
      const clean = {};
      for (const field of fields) {
        const property = properties[field];
        if (!property || !("value" in property)) {
          throw new Error("Invalid field");
        }
        const value = property.value;
        if (PLUGIN_HASH_FIELDS.has(field)) {
          if (!value || typeof value !== "object") {
            throw new Error("Invalid hash");
          }
          const parts = Object.getOwnPropertyDescriptors(value);
          if (Reflect.ownKeys(parts).length !== 1) {
            throw new Error("Invalid hash fields");
          }
          if (
            parts.h &&
            "value" in parts.h &&
            typeof parts.h.value === "string" &&
            /^[0-9a-f]{64}$/.test(parts.h.value)
          ) {
            clean[field] = { h: parts.h.value };
          } else if (parts.present && "value" in parts.present && parts.present.value === false) {
            clean[field] = { present: false };
          } else {
            throw new Error("Invalid hash value");
          }
        } else if (
          field === "reason" &&
          ["idle", "restart", "abort", "mcp-capture-rotation"].includes(value)
        ) {
          clean[field] = value;
        } else if (typeof value === "boolean") {
          clean[field] = value;
        } else if (value && typeof value === "object") {
          const parts = Object.getOwnPropertyDescriptors(value);
          if (
            Reflect.ownKeys(parts).length !== 1 ||
            !parts.present ||
            !("value" in parts.present) ||
            parts.present.value !== false
          ) {
            throw new Error("Invalid absent value");
          }
          clean[field] = { present: false };
        } else {
          throw new Error("Invalid value");
        }
      }
      // HMACs redact, not authenticate: native code shares the trusted process
      // (SECURITY.md, Trusted Plugins). These records never qualify a release.
      // Copy fields so callers cannot mutate retained records after redaction.
      append(event, {
        ...clean,
        hashDomain: "anthropic",
        provenance: "unverified-process-local",
      });
      if (event === "anthropic-decision" && POST_DECISION_TARGET_AUDIT) {
        const targets = pendingTargets.splice(0);
        const decisionSequence = sequence;
        queueMicrotask(() => {
          try {
            auditTargets(targets, decisionSequence);
          } catch {
            failures++;
          }
        });
      }
    } catch {
      failures++;
    }
  };
  Object.defineProperty(globalThis, REDACTED_SLOT, {
    value: receiveRedacted,
    configurable: true,
  });
  observeCliComponentProbe = observe;
  append("probe-start", {
    format: 2,
    targetAudit: POST_DECISION_TARGET_AUDIT,
    noRawValues: true,
    hashDomains: ["core", "anthropic"],
  });
  return {
    observe,
    finish() {
      if (stopped) {
        return;
      }
      if (Object.getOwnPropertyDescriptor(globalThis, REDACTED_SLOT)?.value !== receiveRedacted) {
        failures++;
      }
      const pendingReadyCount = readyListeners.size;
      for (const [watcher, ready] of readyListeners) {
        try {
          watcher.off("ready", ready);
        } catch {
          failures++;
        }
      }
      readyListeners.clear();
      append("probe-end", {
        dropped,
        failures,
        pendingReadyCount,
        pendingTargetCount: pendingTargets.length,
        targetBytes,
      });
      stopped = true;
      observeCliComponentProbe = undefined;
      if (Object.getOwnPropertyDescriptor(globalThis, REDACTED_SLOT)?.value === receiveRedacted) {
        delete globalThis[REDACTED_SLOT];
      }
      bodies.clear();
      pendingTargets.length = 0;
      key.fill(0);
      // Flush only after the original test/cleanup has finished, including failures.
      for (const event of events) {
        process.stderr.write(`[cli-component-probe] ${JSON.stringify(event)}\n`);
      }
      events.length = 0;
    },
  };
}
