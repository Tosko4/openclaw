import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { LogTailPayload } from "../logging/log-tail.js";
import {
  applyLoggingConfig,
  flushLogger,
  getChildLogger,
  setLoggerOverride,
} from "../logging/logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("logs.tail masks complete stored batches while preserving JSON records and byte cursors", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-batch-");
  const file = path.join(dir, "stored.log");
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    "ABCDEF1234567890",
    "-----END PRIVATE KEY-----",
  ] as const;
  const record = (message: string) => JSON.stringify({ message });
  const cases = [
    { lines: pem.map(record), json: [0, 1, 2] },
    { lines: [record(pem.join("\n"))], json: [0] },
    { lines: pem, json: [] },
    { lines: [record(pem[0]), pem[1], record(pem[2])], json: [0, 2] },
    { lines: [record(pem[0]), pem[1], pem[1], pem[1], record(pem[2])], json: [0, 2], count: 3 },
    { lines: [record("Authorization: Basic c2VjcmV0OnBhc3M=")], json: [0] },
    { lines: ["before", "[[],[],[]]", "Authorization: Basic c2VjcmV0OnBhc3M="], json: [1] },
  ];
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  try {
    for (const { lines, json, count = lines.length } of cases) {
      const stored = `${lines.join("\n")}\n`;
      await fs.writeFile(file, stored);
      const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
      expect(response.ok).toBe(true);
      assert(response.payload);
      const tail = response.payload;
      expect(tail.cursor).toBe(Buffer.byteLength(stored));
      expect(tail.size).toBe(Buffer.byteLength(stored));
      expect(tail.lines).toHaveLength(count);
      expect(tail.lines.join("\n")).not.toContain(pem[1]);
      expect(tail.lines.join("\n")).not.toContain("c2VjcmV0OnBhc3M=");
      for (const index of json) {
        const line = tail.lines[index];
        assert(line !== undefined);
        expect(() => JSON.parse(line)).not.toThrow();
      }
      const next = await rpcReq<LogTailPayload>(ws, "logs.tail", { cursor: tail.cursor });
      expect(next.payload?.lines).toEqual([]);
    }
  } finally {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it("logs.tail applies patterns and numeric secrets registered after the file was written", async () => {
  const dir = tempDirs.make("openclaw-gateway-log-policy-");
  const file = path.join(dir, "stored.log");
  const fresh = '{ "message": "already ***", "ordinary": 42 }';
  await fs.writeFile(
    file,
    [JSON.stringify({ message: "MASKME PRIVATE_STORED", numeric: 73928164 }), fresh].join("\n") +
      "\n",
  );
  setLoggerOverride({ file, level: "silent", consoleLevel: "silent" });
  applyLoggingConfig({ redactPatterns: ["MASKME", String.raw`/\*\*\* (PRIVATE_[A-Z]+)/g`] });
  registerSecretValueForRedaction("73928164");
  try {
    const response = await rpcReq<LogTailPayload>(ws, "logs.tail", { limit: 100 });
    expect(response.ok).toBe(true);
    expect(response.payload?.lines.map((line) => JSON.parse(line))).toEqual([
      { message: "*** ***", numeric: "***" },
      { message: "already ***", ordinary: 42 },
    ]);
    expect(response.payload?.lines[1]).toBe(fresh);
  } finally {
    applyLoggingConfig(undefined);
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});

it("tails configured rolling placeholders through authenticated Gateway RPC", async () => {
  const tempDir = tempDirs.make("openclaw-gateway-log-tail-");
  setLoggerOverride({
    file: path.join(tempDir, "openclaw-YYYY-MM-DD.log"),
    level: "info",
    consoleLevel: "silent",
  });
  try {
    getChildLogger({ module: "log-tail" }).warn({ reason: "disabled" }, "rolling RPC record");
    await flushLogger();

    const response = await rpcReq<{ file: string; lines: string[] }>(ws, "logs.tail", {
      limit: 200,
      maxBytes: 256_000,
    });

    expect(response.ok).toBe(true);
    expect(response.payload?.lines).toEqual(
      expect.arrayContaining([expect.stringContaining("rolling RPC record")]),
    );
    expect(path.dirname(response.payload?.file ?? "")).toBe(tempDir);
    expect(path.basename(response.payload?.file ?? "")).toMatch(
      /^openclaw-\d{4}-\d{2}-\d{2}\.log$/,
    );
  } finally {
    await flushLogger();
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  }
});
