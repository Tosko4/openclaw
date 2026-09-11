/**
 * Shared durable room observation and bounded reply-history helpers.
 *
 * Use `recordConversationObservation` for durable unread context. Unmigrated channels keep
 * `createChannelHistoryWindow`; the lower-level map helpers are deprecated compatibility exports.
 */
import type {
  enrichConversationObservationMediaCore,
  recordConversationObservationCore,
} from "../config/sessions/conversation-history.js";
export type { HistoryEntry, HistoryMediaEntry } from "../auto-reply/reply/history.types.js";
export type {
  ConversationHistoryCapture,
  ConversationHistoryMessage,
} from "../sessions/user-turn-input.types.js";

export const recordConversationObservation: typeof recordConversationObservationCore = async (
  ...args
) => {
  const history = await import("../config/sessions/conversation-history.js");
  return history.recordConversationObservationCore(...args);
};
export const enrichConversationObservationMedia: typeof enrichConversationObservationMediaCore =
  async (...args) => {
    const history = await import("../config/sessions/conversation-history.js");
    return history.enrichConversationObservationMediaCore(...args);
  };
export {
  createChannelHistoryWindow,
  type ChannelHistoryWindow,
} from "../channels/turn/history-window.js";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  HISTORY_CONTEXT_MARKER,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildInboundHistoryFromEntries,
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  evictOldHistoryKeys,
  normalizeHistoryMediaEntries,
  recordPendingHistoryEntryWithMedia,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
