import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import {
  readLatestTranscriptEntry,
  readTranscriptEntry,
  readTranscriptLibraryEntry,
} from "./store-read.js";
import { TranscriptsStore } from "./store.js";

export function createTranscriptLibraryStoreFixture(stateDir: string) {
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  return {
    stateDir,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), options),
    database: () => openOpenClawStateDatabase(options).db,
  };
}

export function transcriptLibrarySession(
  sessionId: string,
  overrides: Partial<TranscriptSessionDescriptor> = {},
): TranscriptSessionDescriptor {
  return {
    sessionId,
    title: sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

export function observeArchiveReads(
  store: ReturnType<typeof createTranscriptLibraryStoreFixture>["store"],
  database: DatabaseSync,
) {
  // SQL allocation assertions use the same kernels locally; the worker fixture
  // separately proves the real facade's transport and absence of parent SQL.
  vi.spyOn(store, "readEntry").mockImplementation(async (selector, purpose) =>
    readTranscriptEntry(database, selector, purpose),
  );
  vi.spyOn(store, "readLatestEntry").mockImplementation(async () =>
    readLatestTranscriptEntry(database),
  );
  vi.spyOn(store, "readLibraryEntry").mockImplementation(async (params) =>
    readTranscriptLibraryEntry(database, params),
  );
  clearNodeSqliteKyselyCacheForDatabase(database);
  const queries: Array<{
    sql: string;
    rows: number;
    bytes: number;
    maxRowBytes: number;
    closed: boolean;
  }> = [];
  const location = database.location();
  const prototype = requireNodeSqlite().DatabaseSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
  const prepare = prototype.prepare;
  const prepareSpy = vi.spyOn(prototype, "prepare");
  prepareSpy.mockImplementation(function (this: DatabaseSync, sql) {
    const statement = prepare.call(this, sql);
    if (
      this.location() !== location ||
      !/^select\b/iu.test(sql) ||
      !sql.includes("meeting_transcript_")
    ) {
      return statement;
    }
    const record = { sql, rows: 0, bytes: 0, maxRowBytes: 0, closed: false };
    queries.push(record);
    const observeRow = (row: Record<string, unknown>) => {
      const bytes = Object.values(row).reduce<number>(
        (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value) : 0),
        0,
      );
      record.rows++;
      record.bytes += bytes;
      record.maxRowBytes = Math.max(record.maxRowBytes, bytes);
    };
    const nativeGet = statement.get.bind(statement);
    vi.spyOn(statement, "get").mockImplementation(
      new Proxy(nativeGet, {
        apply(get, _receiver, parameters) {
          try {
            const row = get(...parameters);
            if (row) {
              observeRow(row);
            }
            return row;
          } finally {
            record.closed = true;
          }
        },
      }),
    );
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation((...parameters) => {
      const iterator = iterate(...parameters);
      const next = iterator.next.bind(iterator);
      vi.spyOn(iterator, "next").mockImplementation(() => {
        const result = next();
        if (result.done) {
          record.closed = true;
        } else {
          observeRow(result.value);
        }
        return result;
      });
      if (iterator.return) {
        const finish = iterator.return.bind(iterator);
        vi.spyOn(iterator, "return").mockImplementation(() => {
          record.closed = true;
          return finish();
        });
      }
      return iterator;
    });
    return statement;
  });
  return queries;
}
