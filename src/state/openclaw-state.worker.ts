import { err, ok } from "@openclaw/normalization-core/result";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  countLivePluginStateNamespaceEntries,
  deletePluginStateEntry,
  lookupPluginStateEntry,
  registerPluginStateEntry,
} from "../plugin-state/plugin-state-store.kernel.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  deletePluginStateEntryIfEqual,
  registerPluginStateEntryIfAbsent,
} from "../plugin-state/plugin-state-store.mutations.js";
import {
  listPluginStateEntries,
  lookupPluginStateEntries,
} from "../plugin-state/plugin-state-store.reads.js";
import {
  withPluginStateDatabaseReadOnly,
  wrapPluginStateError,
} from "../plugin-state/plugin-state-store.sqlite.js";
import {
  isPluginStateWorkerCommand,
  pluginStateWorkerOperations,
} from "../plugin-state/plugin-state-worker-contract.js";
import { capturePluginStateWorkerFailure } from "../plugin-state/plugin-state-worker-errors.js";
import { mapTaskFlowView } from "../tasks/task-domain-views.js";
import {
  assertControllerId,
  normalizeRestoredFlowRecord,
} from "../tasks/task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  listTaskFlowRecordsForOwnerReadInDatabase,
  readTaskFlowRecord,
  listTaskFlowViewRecordsForOwnerInDatabase,
  readTaskFlowViewRecordInDatabase,
  updateTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  findTaskRecordByRunIdForViewInDatabase,
  listTaskRecordsForFlowReadInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  readTaskViewRecordInDatabase,
} from "../tasks/task-registry.store.kernel.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import {
  closeOpenClawStateDatabaseByPath,
  clearOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

const log = createSubsystemLogger("state/worker");
type ManagedFlowWriteResult =
  | OpenClawStateWorkerOperations["flows.createManaged"]["output"]
  | OpenClawStateWorkerOperations["flows.updateManaged"]["output"];

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  return openExistingSqliteWorkerBackend(undefined, context);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  const open = () =>
    openOpenClawStateDatabase({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  const listFlows = (db: ReturnType<typeof open>["db"], ownerKey: string) =>
    listTaskFlowRecordsForOwnerReadInDatabase(db, ownerKey).map(normalizeRestoredFlowRecord);
  const ownedFlow = (flow: ReturnType<typeof readTaskFlowRecord>, ownerKey: string) =>
    flow?.ownerKey.trim() === ownerKey ? normalizeRestoredFlowRecord(flow) : undefined;
  return {
    execute(command) {
      if (command.type === "database.generationMatches") {
        // Unavailable inspection retains the known failure; only a stable mismatch expires it.
        return sameSqliteFileGeneration(
          command.input.generation,
          readStableSqliteFileGeneration(context.databasePath),
        );
      }
      if (command.type === "flows.createManaged" || command.type === "flows.updateManaged") {
        let observed: TaskFlowRecord | undefined;
        let committed: ManagedFlowWriteResult | undefined;
        try {
          const database = open();
          return runOpenClawStateWriteTransaction(
            ({ db: writer }) => {
              let result: ManagedFlowWriteResult;
              if (command.type === "flows.createManaged") {
                const flow = command.input.flow;
                if (flow.syncMode !== "managed") {
                  throw new Error("Worker creation requires a managed flow");
                }
                assertControllerId(flow.controllerId);
                upsertTaskFlowRowInDatabase(writer, bindTaskFlowRecord(flow));
                result = flow;
              } else {
                observed = ownedFlow(
                  readTaskFlowRecord(writer, command.input.flowId),
                  command.input.ownerKey,
                );
                result = !observed
                  ? { applied: false, reason: "not_found" }
                  : observed.syncMode !== "managed" || !observed.controllerId
                    ? { applied: false, reason: "not_managed", current: observed }
                    : updateTaskFlowRecordInDatabase(writer, command.input);
              }
              deferSqlitePostCommitPublication(writer, () => {
                committed = result;
              });
              return result;
            },
            {
              path: context.databasePath,
              database,
              env: getSqliteWorkerStateContext().environment,
            },
          );
        } catch (error) {
          if (committed) {
            log.warn("Managed task-flow write committed before cleanup failed", {
              flowId:
                command.type === "flows.createManaged"
                  ? command.input.flow.flowId
                  : command.input.flowId,
              error,
            });
            return committed;
          }
          if (command.type === "flows.createManaged") {
            throw error;
          }
          log.warn("Failed to persist managed task-flow update", {
            flowId: command.input.flowId,
            error,
          });
          return {
            applied: false,
            reason: "persist_failed",
            ...(observed ? { current: observed } : {}),
          };
        }
      }
      if (isPluginStateWorkerCommand(command)) {
        const description = pluginStateWorkerOperations[command.type];
        const options = {
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        };
        if (
          command.type === "pluginState.lookup" ||
          command.type === "pluginState.lookupMany" ||
          command.type === "pluginState.entries" ||
          command.type === "pluginState.count"
        ) {
          try {
            switch (command.type) {
              case "pluginState.lookup":
                return ok(
                  withPluginStateDatabaseReadOnly(
                    "lookup",
                    (store) => lookupPluginStateEntry(store, command.input),
                    options,
                  ),
                );
              case "pluginState.lookupMany": {
                const rows =
                  withPluginStateDatabaseReadOnly(
                    "lookup",
                    (store) => lookupPluginStateEntries(store, command.input),
                    options,
                  ) ?? command.input.keys.map(() => ok(undefined));
                return ok(
                  rows.map((row) =>
                    row.ok ? row : err(capturePluginStateWorkerFailure(row.error)),
                  ),
                );
              }
              case "pluginState.entries":
                return ok(
                  withPluginStateDatabaseReadOnly(
                    "entries",
                    (store) => listPluginStateEntries(store, command.input),
                    options,
                  ) ?? [],
                );
              case "pluginState.count":
                return ok(
                  withPluginStateDatabaseReadOnly(
                    "count",
                    ({ db }) =>
                      countLivePluginStateNamespaceEntries(db, {
                        ...command.input,
                        now: Date.now(),
                      }),
                    options,
                  ) ?? 0,
                );
            }
          } catch (error) {
            return err(
              capturePluginStateWorkerFailure(
                wrapPluginStateError(
                  error,
                  description.operation,
                  description.code,
                  description.message,
                  context.databasePath,
                ),
              ),
            );
          }
        }
        try {
          if (!isOpenClawStateDatabaseOpen(context.databasePath)) {
            open();
          }
        } catch (error) {
          return err(
            capturePluginStateWorkerFailure(
              wrapPluginStateError(
                error,
                description.operation,
                "PLUGIN_STATE_OPEN_FAILED",
                "Failed to open the plugin state database.",
                context.databasePath,
              ),
            ),
          );
        }
        try {
          return ok(
            runOpenClawStateWriteTransaction((store) => {
              switch (command.type) {
                case "pluginState.register":
                  return registerPluginStateEntry(
                    store,
                    command.input,
                    command.input.maxPluginEntries,
                  );
                case "pluginState.registerIfAbsent":
                  return registerPluginStateEntryIfAbsent(
                    store,
                    command.input,
                    command.input.maxPluginEntries,
                  );
                case "pluginState.deleteIfEqual":
                  return deletePluginStateEntryIfEqual(store, command.input);
                case "pluginState.consume":
                  return consumePluginStateEntry(store, command.input);
                case "pluginState.delete":
                  return deletePluginStateEntry(store.db, command.input) > 0;
                case "pluginState.clear":
                  return clearPluginStateNamespace(store.db, command.input);
                default:
                  throw new Error("Plugin-state read command entered its write path");
              }
            }, options),
          );
        } catch (error) {
          return err(
            capturePluginStateWorkerFailure(
              wrapPluginStateError(
                error,
                description.operation,
                description.code,
                description.message,
                context.databasePath,
              ),
            ),
          );
        }
      }
      const { db } = open();
      return runSqliteDeferredTransactionSync(db, () => {
        switch (command.type) {
          case "tasks.get":
            return readTaskViewRecordInDatabase(db, command.input.taskId);
          case "tasks.list":
            return listTaskRecordsForOwnerReadInDatabase(db, command.input.ownerKey);
          case "tasks.resolve": {
            const { ownerKey, token } = command.input;
            return {
              direct: readTaskViewRecordInDatabase(db, token),
              byRun: findTaskRecordByRunIdForViewInDatabase(db, token),
              related: listTaskRecordsForOwnerReadInDatabase(db, ownerKey, token),
            };
          }
          case "flows.list":
            return listFlows(db, command.input.ownerKey);
          case "flows.views":
            return listTaskFlowViewRecordsForOwnerInDatabase(db, command.input.ownerKey)
              .map(normalizeRestoredFlowRecord)
              .map(mapTaskFlowView);
          case "flows.summary": {
            const { ownerKey, flowId } = command.input;
            const flow = ownedFlow(readTaskFlowViewRecordInDatabase(db, flowId), ownerKey);
            return flow
              ? summarizeTaskRecords(listTaskRecordsForFlowReadInDatabase(db, flow.flowId))
              : undefined;
          }
          case "flows.current": {
            const flow = readTaskFlowRecord(db, command.input.flowId);
            return flow ? normalizeRestoredFlowRecord(flow) : undefined;
          }
          case "flows.read":
          case "flows.detail": {
            const { ownerKey, lookup, token } = command.input;
            const direct = token === undefined ? undefined : readTaskFlowRecord(db, token);
            let flow = ownedFlow(direct, ownerKey);
            if (
              !flow &&
              (lookup === "latest" || (lookup === "resolve" && token?.trim() === ownerKey))
            ) {
              const flows = listFlows(db, ownerKey);
              flow =
                lookup === "resolve"
                  ? (flows.find((candidate) => !isTerminalTaskFlow(candidate)) ?? flows[0])
                  : flows[0];
            }
            if (!flow) {
              return undefined;
            }
            return command.type === "flows.detail"
              ? { flow, tasks: listTaskRecordsForFlowReadInDatabase(db, flow.flowId) }
              : flow;
          }
          default:
            throw new Error("Unknown shared-state SQLite command");
        }
      });
    },
    close() {
      closeOpenClawStateDatabaseByPath(context.databasePath);
      clearOpenClawStateDatabaseOpenFailure(context.databasePath);
    },
  };
}
