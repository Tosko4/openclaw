import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { settleModelCatalogRequests } from "../model-catalog-cache.ts";
import { loadModelCatalog, peekModelCatalog } from "../model-catalog-store.ts";
import {
  chatMetadataCache,
  notifyChatMetadataListeners,
  type ChatMetadataEntry,
  type ChatMetadataRefresh,
  type ChatMetadataRefreshRecord,
  type ChatMetadataResult,
  type ChatMetadataUpdate,
  type ChatMetadataWriter,
} from "./chat-metadata-cache.ts";

function metadataScopeKey(scope: ChatMetadataParams): string {
  return JSON.stringify([
    scope.agentId?.trim() ?? "",
    scope.sessionKey ?? null,
    scope.authProfileId ?? null,
  ]);
}

function metadataEntryFor(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
): ChatMetadataEntry {
  const key = metadataScopeKey(params);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    cache = new Map();
    chatMetadataCache.set(client, cache);
  }
  let entry = cache.get(key);
  if (!entry) {
    const created: ChatMetadataEntry = {
      scope: params,
      listeners: new Map(),
      refreshRevision: 0,
      release: () => {
        // Selected-account projections live with their consumers, not every conversation/draft.
        // Retire the writer too: a late startup/read cannot repopulate a released entry.
        if ((params.sessionKey || params.authProfileId) && created.listeners.size === 0) {
          if (created.writer || created.result) {
            created.refreshRevision += 1;
          }
          created.writer = undefined;
          created.result = undefined;
          if (
            created.refresh?.phase !== "running" &&
            created.refresh?.phase !== "waiting" &&
            cache.get(key) === created
          ) {
            cache.delete(key);
          }
        }
      },
    };
    entry = created;
    cache.set(key, entry);
  }
  return entry;
}

function waitForMetadataRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const retryWindowMs = opts?.startupRetryWindowMs;
  if (retryWindowMs === undefined) {
    return client.request<ChatMetadataResult>("chat.metadata", params);
  }

  const deadlineAt = Date.now() + retryWindowMs;
  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<ChatMetadataResult>("chat.metadata", params, {
        timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}

function beginPublication(entry: ChatMetadataEntry, revalidating = false) {
  const writer: ChatMetadataWriter = { revalidating };
  entry.writer = writer;
  const isCurrent = () => entry.writer === writer;
  return {
    writer,
    isCurrent,
    publish: (result: ChatMetadataResult & { models?: unknown; accountSelection?: unknown }) => {
      writer.pending = undefined;
      // Legacy/startup responses can carry models. The direct catalog is their only UI owner.
      const { models: _models, accountSelection: _accountSelection, ...metadata } = result;
      if (isCurrent()) {
        entry.result = metadata;
        notifyChatMetadataListeners(entry, { type: "result", result: metadata });
      }
      entry.release();
      return metadata;
    },
    fail: (error: unknown) => {
      writer.pending = undefined;
      if (isCurrent()) {
        notifyChatMetadataListeners(entry, { type: "error", error });
      }
      entry.release();
      throw error;
    },
  };
}

function beginChatMetadataRequest(
  entry: ChatMetadataEntry,
  request: Promise<ChatMetadataResult>,
  revalidating = false,
): Promise<ChatMetadataResult> {
  const { writer, publish, fail } = beginPublication(entry, revalidating);
  const pending = request.then(publish, fail);
  writer.pending = pending;
  notifyChatMetadataListeners(entry, { type: "loading" });
  return pending;
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.get(metadataScopeKey(scope))?.result;
}

export function subscribeChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  listener: (update: ChatMetadataUpdate) => void,
  isActive: () => boolean = () => true,
): () => void {
  const entry = metadataEntryFor(client, scope);
  entry.listeners.set(listener, isActive);
  return () => {
    entry.listeners.delete(listener);
    entry.release();
  };
}

function loadChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  const pending = entry.writer?.pending;
  if (pending) {
    return pending;
  }
  return beginChatMetadataRequest(entry, requestChatMetadata(client, entry.scope));
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  const writer = entry.writer;
  if (writer?.revalidating && writer.pending) {
    return writer.pending;
  }
  return beginChatMetadataRequest(entry, requestChatMetadata(client, entry.scope, opts), true);
}

export function beginChatMetadataPublication(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
) {
  const entry = metadataEntryFor(client, scope);
  const { isCurrent, publish } = beginPublication(entry);
  notifyChatMetadataListeners(entry, { type: "loading" });
  return { isCurrent, publish };
}

/** One automatic refresh generation per scope, shared by every presentation. */
export function loadChatMetadataRefresh(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  options?: {
    automatic?: boolean;
    kind?: "startup" | "metadata";
    revalidateMetadata?: () => boolean;
  },
): ChatMetadataRefresh {
  const entry = metadataEntryFor(client, scope);
  const previous = entry.refresh;
  const metadataRequired = options?.kind !== "startup";
  const catalogRequired = options?.kind !== "metadata";
  const revalidate = options?.revalidateMetadata?.() === true;
  if (previous?.phase === "waiting") {
    previous.metadataRequired ||= metadataRequired;
    previous.catalogRequired ||= catalogRequired;
    if (revalidate) {
      previous.revalidateMetadata = options?.revalidateMetadata;
    }
    previous.revision = entry.refreshRevision;
    if (!options?.automatic) {
      previous.start(true);
    }
    return previous;
  }
  if (
    previous?.phase === "running" &&
    previous.revision === entry.refreshRevision &&
    (options?.automatic || !previous.failed) &&
    (!metadataRequired || previous.metadataRequired) &&
    (!catalogRequired || previous.catalogRequired) &&
    !revalidate
  ) {
    return previous;
  }

  const previousSettlement = previous?.settled;
  const catalog = createDeferredCore<ModelCatalogResult | undefined>();
  const completed = createDeferredCore();
  const settled = createDeferredCore();
  const record: ChatMetadataRefreshRecord = {
    catalog: catalog.promise,
    completed: completed.promise,
    settled: settled.promise,
    phase: "waiting",
    failed: false,
    revision: entry.refreshRevision,
    metadataRequired,
    catalogRequired,
    revalidateMetadata: revalidate ? options?.revalidateMetadata : undefined,
    isCurrent: () =>
      chatMetadataCache.get(client)?.get(metadataScopeKey(scope)) === entry &&
      // A command-only startup fallback must not retire the catalog still serving its panes.
      record.revision === entry.refreshRevision,
    start: (explicit = false) => {
      if (record.phase !== "waiting") {
        return;
      }
      if (
        chatMetadataCache.get(client)?.get(metadataScopeKey(scope)) !== entry ||
        (!explicit &&
          options?.automatic &&
          !Array.from(entry.listeners.values()).some((active) => active()))
      ) {
        record.phase = "inactive";
        catalog.resolve(undefined);
        completed.resolve();
        settled.resolve();
        entry.release();
        return;
      }
      record.phase = "running";
      record.revision = entry.refreshRevision;
      const metadataRead = record.metadataRequired
        ? record.revalidateMetadata?.()
          ? revalidateChatMetadata(client, scope)
          : loadChatMetadata(client, scope)
        : Promise.resolve();
      const catalogRead = record.catalogRequired
        ? loadModelCatalog(client, scope)
        : Promise.resolve(peekModelCatalog(client, scope));
      // Capture transport settlement now: accepted snapshots or explicit refreshes
      // may fulfill subscribers and replace the catalog pending slot first.
      const catalogSettlement = settleModelCatalogRequests(client, scope);
      void catalogRead.then(catalog.resolve, catalog.reject);
      void Promise.allSettled([metadataRead, catalogRead]).then(
        ([metadataResult, catalogResult]) => {
          record.failed =
            metadataResult.status === "rejected" ||
            catalogResult.status === "rejected" ||
            catalogResult.value?.refreshFailed === true;
          completed.resolve();
        },
      );
      void Promise.allSettled([metadataRead, catalogSettlement, previousSettlement]).then(() => {
        record.phase = "settled";
        settled.resolve();
        entry.release();
      });
    },
  };
  entry.refresh = record;
  if (
    options?.automatic &&
    previous &&
    previous.phase !== "settled" &&
    previous.phase !== "inactive"
  ) {
    void previousSettlement?.then(() => record.start());
  } else {
    record.start();
  }
  return record;
}
