import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { invalidateModelCatalogCache } from "../model-catalog-cache.ts";
import { uiConversationMatches, type UiSessionDefaultsHost } from "../sessions/session-key.ts";

export type ChatMetadataResult = CommandsListResult;

export type ChatMetadataUpdate =
  | { type: "invalidated"; refreshSessionFacts: boolean }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
export type ChatMetadataWriter = {
  pending?: Promise<ChatMetadataResult>;
  revalidating: boolean;
};

export type ChatMetadataRefresh = {
  catalog: Promise<ModelCatalogResult | undefined>;
  completed: Promise<void>;
  isCurrent: () => boolean;
};

export type ChatMetadataRefreshRecord = ChatMetadataRefresh & {
  settled: Promise<void>;
  phase: "waiting" | "running" | "settled" | "inactive";
  failed: boolean;
  revision: number;
  metadataRequired: boolean;
  catalogRequired: boolean;
  revalidateMetadata?: () => boolean;
  start: (explicit?: boolean) => void;
};

export type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  result?: ChatMetadataResult;
  refreshRevision: number;
  refresh?: ChatMetadataRefreshRecord;
  writer?: ChatMetadataWriter;
  listeners: Map<(update: ChatMetadataUpdate) => void, () => boolean>;
  release: () => void;
};

export const chatMetadataCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, ChatMetadataEntry>
>();

export function notifyChatMetadataListeners(
  entry: ChatMetadataEntry,
  update: ChatMetadataUpdate,
): void {
  for (const listener of Array.from(entry.listeners.keys())) {
    try {
      listener(update);
    } catch (error) {
      console.error("[chat-metadata] listener error:", error);
    }
  }
}

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
  sessionDefaults?: UiSessionDefaultsHost,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  invalidateModelCatalogCache(
    client,
    sessionDefaults && scope?.sessionKey ? { agentId: scope.agentId, sessionsOnly: true } : scope,
  );
  const entries = chatMetadataCache.get(client)?.values();
  if (!entries) {
    return;
  }
  const invalidated = Array.from(entries).filter(
    (entry) =>
      (sessionDefaults && scope?.sessionKey
        ? uiConversationMatches(
            { ...sessionDefaults, assistantAgentId: entry.scope.agentId },
            entry.scope.sessionKey,
            scope.sessionKey,
            scope.agentId,
          )
        : (!scope?.agentId || entry.scope.agentId === scope.agentId) &&
          (!scope?.sessionKey || entry.scope.sessionKey === scope.sessionKey)) &&
      (!scope?.authProfileId || entry.scope.authProfileId === scope.authProfileId),
  );
  // Retire every affected writer before subscribers can synchronously start replacements.
  for (const entry of invalidated) {
    entry.refreshRevision += 1;
    entry.result = undefined;
    entry.writer = undefined;
  }
  for (const entry of invalidated) {
    notifyChatMetadataListeners(entry, {
      type: "invalidated",
      // Session mutations own roster reconciliation; global catalog changes also change session facts.
      refreshSessionFacts: !scope?.sessionKey,
    });
    entry.release();
  }
}
