// These consumers need the host-owned SQLite broker, which runs in forked processes.
export const databaseWorkerCoreTestFiles = [
  "src/agents/tools/transcripts-tool-read.test.ts",
  "src/agents/tools/transcripts-tool.account-ownership.test.ts",
  "src/agents/tools/transcripts-tool.auto-start.test.ts",
  "src/agents/tools/transcripts-tool.import.test.ts",
  "src/agents/tools/transcripts-tool.lifecycle.test.ts",
  "src/agents/tools/transcripts-tool.occupancy.test.ts",
  "src/agents/tools/transcripts-tool.selection.test.ts",
  "src/agents/tools/transcripts-tool.session-id.test.ts",
  "src/agents/tools/transcripts-tool.status.test.ts",
  "src/agents/tools/transcripts-tool.test.ts",
  "src/meeting-bot/session-runtime.test.ts",
  "src/meeting-bot/transcripts-bridge.test.ts",
  "src/transcripts/capture-stop.test.ts",
  "src/transcripts/library.async.test.ts",
  "src/transcripts/library.query-budget.test.ts",
  "src/transcripts/library.search.test.ts",
  "src/transcripts/library.test.ts",
  "src/transcripts/status.metadata.test.ts",
  "src/transcripts/status.occupancy.test.ts",
  "src/transcripts/status.producer.test.ts",
  "src/transcripts/status.provider-reload.test.ts",
  "src/transcripts/status.test.ts",
  "src/transcripts/store.test.ts",
  "test/transcripts-tool.discord-lifecycle.integration.test.ts",
  "test/transcripts-tool.discord-provider.integration.test.ts",
];

const databaseWorkerCoreTestFileSet = new Set(databaseWorkerCoreTestFiles);

export function isDatabaseWorkerCoreTestFile(file) {
  return databaseWorkerCoreTestFileSet.has(file.replaceAll("\\", "/"));
}
