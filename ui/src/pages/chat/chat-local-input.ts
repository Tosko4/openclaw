import type { SessionProjectionScope } from "@openclaw/gateway-client/browser";
// Live local session input receipts. A `submitted` chat.send ack means the
// Gateway relayed the message to the teammate's device; no Gateway run exists,
// so the optimistic bubble is retired only by the mirrored native user record
// (`__openclaw.localInputId`) or replaced by a rejection.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { SenderIdentity } from "../../lib/chat/sender-label.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  localSourceFollowUpModes,
  localSourceInputBlockedReason,
  type SessionLocalInputState,
  type SessionLocalSource,
} from "../../lib/sessions/local-source.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { LOCAL_INPUT_STATES, type LocalInputFooter } from "./chat-local-input-footer.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { hasDirectSessionRun } from "./run-lifecycle.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

type LocalInputMessage = {
  text: string;
  mentions?: readonly HumanMention[];
  attachments?: ChatAttachment[];
  createdAt: number;
  replyToId?: string;
  sender?: SenderIdentity;
};

export type LocalInputReceipt = {
  inputId: string;
  runId: string;
  sessionKey: string;
  agentId?: string;
  sourceLabel: string;
  /** Sources without steering read new input at their next turn boundary. */
  nextTurnDelivery: boolean;
  state: SessionLocalInputState;
  reason?: string;
  message: LocalInputMessage;
};

// Receipts are per pane and per session lifetime; the cap only bounds a pane
// that sends far more than a device can commit before reload.
const MAX_TRACKED_LOCAL_INPUTS = 32;
const localInputReceipts = new WeakMap<object, Map<string, LocalInputReceipt>>();

/** The live local source behind a session key, from the shared session roster. */
export function readLocalSessionSource(
  host: { sessions?: Partial<SessionCapability> },
  sessionKey: string,
): SessionLocalSource | undefined {
  return host.sessions?.state?.result?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, sessionKey),
  )?.localSource;
}

/**
 * How a send behaves while a turn is running. Gateway runs send now unless the
 * follow-up policy queues, and an unloaded policy leaves the mode to the
 * Gateway. A live local session has no Gateway run: while the device's own
 * turn is active, the chosen follow-up mode names how the harness takes the
 * input; idle sources start a turn and need no mode.
 */
export function resolveActiveRunSend(
  host: Parameters<typeof hasDirectSessionRun>[0] & { sessions?: Partial<SessionCapability> },
  sessionKey: string,
  followUpMode: ControlUiFollowUpMode | undefined,
): { queueMode: QueueMode | undefined; sendNow: boolean } {
  const source = readLocalSessionSource(host, sessionKey);
  if (!source) {
    const sendNow = hasDirectSessionRun(host) && followUpMode !== "queue";
    return { queueMode: sendNow ? followUpMode : undefined, sendNow };
  }
  if (source.state !== "active") {
    return { queueMode: undefined, sendNow: false };
  }
  const steer = followUpMode === "steer" && source.inputModes.includes("steer");
  return { queueMode: steer ? "steer" : "followup", sendNow: false };
}

/** Composer facts for a live local session; undefined for Gateway-run sessions. */
export function resolveLocalSessionComposer(
  host: ChatState & Pick<ChatPageHost, "handleSendChat">,
  source: SessionLocalSource | undefined,
) {
  if (!source) {
    return undefined;
  }
  const modes = localSourceFollowUpModes(source);
  const rejected = readRejectedLocalInput(host);
  return {
    followUpMode: modes[0],
    blockedReason: localSourceInputBlockedReason(source),
    followUp: { modes, active: source.state === "active" },
    retry: rejected
      ? {
          id: rejected.inputId,
          onRetry: () => {
            const receipt = takeRejectedLocalInput(host, rejected.inputId);
            if (receipt) {
              void host.handleSendChat(receipt.message.text, {
                mentionsOverride: receipt.message.mentions,
                attachmentsOverride: receipt.message.attachments,
                restoreDraft: true,
              });
            }
          },
        }
      : undefined,
  };
}

function receiptsFor(host: ChatState): Map<string, LocalInputReceipt> {
  let receipts = localInputReceipts.get(host);
  if (!receipts) {
    receipts = new Map();
    localInputReceipts.set(host, receipts);
  }
  return receipts;
}

function receiptScope(host: ChatState, receipt: LocalInputReceipt): SessionProjectionScope {
  return readChatSessionProjectionScope(host, {
    sessionKey: receipt.sessionKey,
    agentId: receipt.agentId,
  });
}

function readLocalInputId(message: unknown): string | null {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  const inputId = metadata?.localInputId;
  return typeof inputId === "string" && inputId.trim() ? inputId.trim() : null;
}

function projectReceipt(
  host: ChatState,
  receipt: LocalInputReceipt,
  scope: SessionProjectionScope,
) {
  const rejected = receipt.state === "rejected";
  const message = buildLocalUserMessage({
    ...receipt.message,
    runId: receipt.runId,
    pending: {
      id: receipt.inputId,
      state: rejected ? "failed" : "sending",
      ...(rejected && receipt.reason ? { error: receipt.reason } : {}),
    },
  });
  if (!message) {
    return;
  }
  const footer: LocalInputFooter = {
    inputId: receipt.inputId,
    sourceLabel: receipt.sourceLabel,
    nextTurnDelivery: receipt.nextTurnDelivery,
    state: receipt.state,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
  };
  // The reducer keeps the first pending row for a run; drop it before
  // re-projecting so each receipt state replaces the bubble in place.
  reduceChatSessionProjection(host, { type: "sendFailed", runId: receipt.runId }, { scope });
  reduceChatSessionProjection(
    host,
    {
      type: "sendPending",
      runId: receipt.runId,
      message: { ...message, __openclaw: { ...message["__openclaw"], localInput: footer } },
    },
    { scope },
  );
}

/** Track a `submitted` ack and show its optimistic bubble until the device echoes it. */
export function recordLocalInputSubmission(
  host: ChatState,
  params: {
    inputId: string;
    runId: string;
    sessionKey: string;
    agentId?: string;
    source: Pick<SessionLocalSource, "sourceLabel" | "inputModes">;
    message: LocalInputMessage;
    scope: SessionProjectionScope;
  },
): void {
  const receipts = receiptsFor(host);
  while (receipts.size >= MAX_TRACKED_LOCAL_INPUTS) {
    const oldest = receipts.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    receipts.delete(oldest);
  }
  // The device can commit and mirror the record before the ack returns.
  const alreadyMirrored = getChatSessionProjection(host, params.scope).messages.some(
    (message) => readLocalInputId(message) === params.inputId,
  );
  if (alreadyMirrored) {
    return;
  }
  const receipt: LocalInputReceipt = {
    inputId: params.inputId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sourceLabel: params.source.sourceLabel,
    nextTurnDelivery: !params.source.inputModes.includes("steer"),
    state: "accepted",
    message: params.message,
  };
  receipts.set(receipt.inputId, receipt);
  projectReceipt(host, receipt, params.scope);
}

/** Apply one `session.localInput` event; returns whether a tracked bubble changed. */
export function applyLocalInputEvent(host: ChatState, payload: unknown): boolean {
  const event = asNullableRecord(payload);
  const inputId = typeof event?.inputId === "string" ? event.inputId.trim() : "";
  const state = typeof event?.state === "string" ? event.state : "";
  const receipt = localInputReceipts.get(host)?.get(inputId);
  if (!receipt || !LOCAL_INPUT_STATES.has(state)) {
    return false;
  }
  const reason =
    typeof event?.reason === "string" && event.reason.trim() ? event.reason : undefined;
  if (receipt.state === state && receipt.reason === reason) {
    return false;
  }
  // SAFETY: state was checked against the closed input-state list above.
  receipt.state = state as SessionLocalInputState;
  receipt.reason = reason;
  projectReceipt(host, receipt, receiptScope(host, receipt));
  return true;
}

/** Mirrored native user records retire their optimistic bubble; no double bubble. */
export function retireLocalInputsForMessages(host: ChatState, messages: readonly unknown[]): void {
  const receipts = localInputReceipts.get(host);
  if (!receipts?.size) {
    return;
  }
  for (const message of messages) {
    const inputId = readLocalInputId(message);
    const receipt = inputId ? receipts.get(inputId) : undefined;
    if (!receipt) {
      continue;
    }
    receipts.delete(receipt.inputId);
    reduceChatSessionProjection(
      host,
      { type: "sendFailed", runId: receipt.runId },
      { scope: receiptScope(host, receipt) },
    );
  }
}

/** The rejected input whose bubble offers Retry; newest rejection wins. */
export function readRejectedLocalInput(host: ChatState): LocalInputReceipt | undefined {
  const receipts = localInputReceipts.get(host);
  if (!receipts) {
    return undefined;
  }
  return [...receipts.values()].findLast((receipt) => receipt.state === "rejected");
}

/** Remove a rejected input so its text can be resubmitted as a fresh send. */
export function takeRejectedLocalInput(host: ChatState, inputId: string): LocalInputReceipt | null {
  const receipts = localInputReceipts.get(host);
  const receipt = receipts?.get(inputId);
  if (!receipt || receipt.state !== "rejected") {
    return null;
  }
  receipts?.delete(inputId);
  reduceChatSessionProjection(
    host,
    { type: "sendFailed", runId: receipt.runId },
    { scope: receiptScope(host, receipt) },
  );
  return receipt;
}
