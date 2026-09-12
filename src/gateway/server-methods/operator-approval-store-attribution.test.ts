import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "../../state/openclaw-state-schema-compatibility.js";
import { ensureProfileForEmail, syncGitHubIdentity } from "../../state/user-profiles.js";
import {
  consumeOperatorApprovalAllowOnce,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  pruneTerminalOperatorApprovals,
  projectOperatorApprovalDecisionActor,
  resolveOperatorApproval,
} from "../operator-approval-store.js";

type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const OPERATOR_APPROVAL_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-attribution-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(id: string): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      commandPreview: `echo ${id}`,
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "request-device", clientId: "request-client", deviceTokenAuth: true },
    reviewerDeviceIds: ["reviewer"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
  };
}

function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
  const result = getOperatorApprovalDetailed(params);
  return result.outcome === "found" ? result.record : null;
}

function rawApprovalRow(options: OpenClawStateDatabaseOptions, id: string) {
  const database = openOpenClawStateDatabase(options);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

describe("operator approval decision attribution storage", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("freezes the winning actor through replay, profile merge, rename, reopen, and retention", () => {
    const databaseOptions = createDatabaseOptions();
    const identity = { accountId: 101, login: "reviewer-a" };
    const person = ensureProfileForEmail("reviewer@example.test", databaseOptions);
    const decisionActor = { profileId: person.id, githubLogin: identity.login };
    insertOperatorApproval({ approval: approval("actor-winner"), databaseOptions });
    const decision = {
      id: "actor-winner",
      decision: "allow-once" as const,
      resolver: { kind: "device" as const, id: "shared-client" },
      nowMs: 2_000,
      databaseOptions,
    };
    expect(resolveOperatorApproval({ ...decision, decisionActor })).toMatchObject({
      outcome: "resolved",
      record: { decisionActor },
    });
    for (const verdict of ["allow-once", "deny"] as const) {
      expect(
        resolveOperatorApproval({
          ...decision,
          decision: verdict,
          decisionActor: { profileId: "loser" },
        }),
      ).toMatchObject({ outcome: "already-resolved", record: { decisionActor } });
    }

    const canonical = syncGitHubIdentity(
      { identity, authenticationAlias: { kind: "email", email: "canonical@example.test" } },
      databaseOptions,
    );
    const merged = syncGitHubIdentity(
      {
        identity: { ...identity, login: "renamed-reviewer" },
        authenticationAlias: { kind: "email", email: "reviewer@example.test" },
      },
      databaseOptions,
    );
    expect(merged.id).toBe(canonical.id);
    expect(merged.id).not.toBe(person.id);
    closeOpenClawStateDatabaseForTest();
    const retained = getOperatorApproval({ id: decision.id, nowMs: 3_000, databaseOptions })!;
    expect(
      projectOperatorApprovalDecisionActor(
        retained,
        1_999 + OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
      ),
    ).toEqual(decisionActor);
    expect(
      projectOperatorApprovalDecisionActor(
        retained,
        2_000 + OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
      ),
    ).toBeUndefined();
    expect(getOperatorApproval({ id: decision.id, nowMs: 3_000, databaseOptions })).toMatchObject({
      status: "allowed",
      decisionActor,
    });
    expect(
      consumeOperatorApprovalAllowOnce({
        id: decision.id,
        consumerId: "requester",
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "consumed", record: { decisionActor } });
    pruneTerminalOperatorApprovals({
      nowMs: 2_001 + OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
      databaseOptions,
    });
    expect(rawApprovalRow(databaseOptions, decision.id)).toBeUndefined();
  });

  it("keeps absent and malformed audit metadata out of lifecycle authority", () => {
    const databaseOptions = createDatabaseOptions();
    for (const [id, kind] of [
      ["historical", "runtime"],
      ["channel", "channel"],
      ["corrupt-actor", "device"],
    ] as const) {
      insertOperatorApproval({ approval: approval(id), databaseOptions });
      resolveOperatorApproval({
        id,
        decision: "allow-once",
        resolver: { kind, id: "resolver" },
        ...(id !== "historical"
          ? { decisionActor: { profileId: "person-a", githubLogin: "reviewer-a" } }
          : {}),
        nowMs: 2_000,
        databaseOptions,
      });
    }
    expect(
      getOperatorApproval({ id: "historical", nowMs: 3_000, databaseOptions }),
    ).not.toHaveProperty("decisionActor");
    expect(
      getOperatorApproval({ id: "channel", nowMs: 3_000, databaseOptions }),
    ).not.toHaveProperty("decisionActor");
    const { db } = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("operator_approvals")
        .set({ resolver_profile_id: "x".repeat(257), resolver_github_login: "not a login" })
        .where("approval_id", "=", "corrupt-actor"),
    );
    expect(
      getOperatorApproval({ id: "corrupt-actor", nowMs: 3_000, databaseOptions }),
    ).not.toHaveProperty("decisionActor");
    expect(
      consumeOperatorApprovalAllowOnce({
        id: "corrupt-actor",
        consumerId: "requester",
        nowMs: 3_000,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "consumed" });
  });

  it("adds nullable actor columns on first use and preserves the previous reader/writer contract", () => {
    const databaseOptions = createDatabaseOptions();
    const initial = openOpenClawStateDatabase(databaseOptions).db;
    const version = initial.prepare("PRAGMA user_version").get();
    initial.exec(
      "ALTER TABLE operator_approvals DROP COLUMN resolver_profile_id; ALTER TABLE operator_approvals DROP COLUMN resolver_github_login;",
    );
    closeOpenClawStateDatabaseForTest();
    const { db } = openOpenClawStateDatabase(databaseOptions);
    const actorColumns = () =>
      db
        .prepare("PRAGMA table_info(operator_approvals)")
        .all()
        .filter(
          (column) =>
            column.name === "resolver_profile_id" || column.name === "resolver_github_login",
        );
    expect(actorColumns()).toEqual([]);
    insertOperatorApproval({ approval: approval("first-actor"), databaseOptions });
    expect(actorColumns()).toEqual([]);
    const decisionActor = { profileId: "person-a", githubLogin: "reviewer-a" };
    const decision = {
      id: "first-actor",
      decision: "allow-once" as const,
      resolver: { kind: "device" as const, id: "device" },
      decisionActor,
      nowMs: 2_000,
      databaseOptions,
    };
    expect(resolveOperatorApproval(decision)).toMatchObject({ outcome: "resolved" });
    expect(resolveOperatorApproval(decision)).toMatchObject({ outcome: "already-resolved" });
    expect(
      actorColumns().map(({ name, type, notnull, dflt_value }) => ({
        name,
        type,
        notnull,
        dflt_value,
      })),
    ).toEqual([
      { name: "resolver_profile_id", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "resolver_github_login", type: "TEXT", notnull: 0, dflt_value: null },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    const previousSchema = getOpenClawStateRuntimeSchema({
      includeVersionLazyAdditiveTables: false,
    })
      .replace("  resolver_profile_id TEXT,\n", "")
      .replace("  resolver_github_login TEXT,\n", "");
    expect(() =>
      assertSqliteSchemaContains(
        db,
        "pre-attribution state database",
        previousSchema,
        STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
      ),
    ).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT status, decision, resolver_kind, resolver_id FROM operator_approvals WHERE approval_id = ?",
        )
        .get(decision.id),
    ).toEqual({
      status: "allowed",
      decision: "allow-once",
      resolver_kind: "device",
      resolver_id: "device",
    });
    db.prepare(
      "UPDATE operator_approvals SET consumed_at_ms = ?, consumed_by = ?, updated_at_ms = ? WHERE approval_id = ? AND consumed_at_ms IS NULL",
    ).run(3_000, "previous-reader", 3_000, decision.id);
    insertOperatorApproval({ approval: approval("older-insert"), databaseOptions });
    resolveOperatorApproval({ ...decision, id: "older-insert", decisionActor: undefined });
    closeOpenClawStateDatabaseForTest();
    expect(getOperatorApproval({ id: decision.id, nowMs: 4_000, databaseOptions })).toMatchObject({
      decisionActor,
      consumedBy: "previous-reader",
    });
    expect(
      getOperatorApproval({ id: "older-insert", nowMs: 4_000, databaseOptions }),
    ).not.toHaveProperty("decisionActor");
  });
});
