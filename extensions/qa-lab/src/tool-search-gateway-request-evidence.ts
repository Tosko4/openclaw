import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { countSessionLogMentions, subtractMentionCounts } from "./fixture-utils.js";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { qaMockRequestsAfterUrl } from "./providers/shared/debug-request-cursor.js";

const TOOL_SEARCH_REQUEST_EVIDENCE_LIMIT = 12;
const TOOL_SEARCH_FAILURE_LOG_CHARS = 4_000;
const SAFE_TOOL_SEARCH_STAGE_NAMES = new Set([
  "tool_search_code",
  "tool_search",
  "tool_describe",
  "tool_call",
]);

function readDeclaredToolName(tool: unknown) {
  if (!isRecord(tool)) {
    return null;
  }
  const wrapped = isRecord(tool.function) ? tool.function.name : undefined;
  if (typeof wrapped === "string") {
    return wrapped;
  }
  return typeof tool.name === "string" ? tool.name : null;
}

function readSafePlannedToolName(value: unknown, targetTool: string) {
  if (typeof value !== "string") {
    return null;
  }
  return value === targetTool || SAFE_TOOL_SEARCH_STAGE_NAMES.has(value) ? value : "<other>";
}

function summarizeToolSearchProviderRequests(requests: unknown, targetTool: string) {
  if (!Array.isArray(requests)) {
    return [];
  }
  return requests.slice(-TOOL_SEARCH_REQUEST_EVIDENCE_LIMIT).map((request) => {
    const record = isRecord(request) ? request : {};
    const body = isRecord(record.body) ? record.body : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declaredNames = new Set(
      tools.flatMap((tool) => {
        const name = readDeclaredToolName(tool);
        return name === null ? [] : [name];
      }),
    );
    return {
      plannedToolName: readSafePlannedToolName(record.plannedToolName, targetTool),
      declaredToolCount: tools.length,
      targetDeclared: declaredNames.has(targetTool),
      bridgeDeclared: declaredNames.has("tool_search_code"),
      targetResultObserved:
        targetTool.length > 0 &&
        typeof record.toolOutput === "string" &&
        record.toolOutput.includes("FAKE_PLUGIN_OK") &&
        record.toolOutput.includes(targetTool),
    };
  });
}

export async function countToolSearchSessionLogMentions(params: {
  stateDir: string;
  targetTool: string;
}) {
  return countSessionLogMentions({
    sessionsDir: path.join(params.stateDir, "agents", "qa", "sessions"),
    needles: {
      tool_search_code: "tool_search_code",
      tool_search: "tool_search",
      tool_call: "tool_call",
      [params.targetTool]: params.targetTool,
    },
  });
}

type FetchJson = (
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export async function requestToolSearchGatewayResponse(params: {
  fetchJson: FetchJson;
  gatewayBaseUrl: string;
  gatewayToken: string;
  lane: string;
  mentionCountsBefore: Record<string, number>;
  providerBaseUrl: string;
  requestCursorBefore: number;
  readGatewayLogs: () => string;
  sessionKey: string;
  stateDir: string;
  targetTool: string;
  timeoutMs: number;
}) {
  try {
    return await params.fetchJson(
      `${params.gatewayBaseUrl}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.gatewayToken}`,
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.write",
          "x-openclaw-agent": "qa",
          "x-openclaw-session-key": params.sessionKey,
        },
        body: JSON.stringify({
          model: "openclaw/qa",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `tool search qa check target=${params.targetTool}`,
                },
              ],
            },
          ],
          max_output_tokens: 256,
          stream: false,
        }),
      },
      { timeoutMs: params.timeoutMs },
    );
  } catch (error) {
    const requests = await params
      .fetchJson(qaMockRequestsAfterUrl(params.providerBaseUrl, params.requestCursorBefore))
      .catch(() => []);
    const mentionsAfter = await countToolSearchSessionLogMentions(params).catch(() => null);
    const sessionMentions = mentionsAfter
      ? subtractMentionCounts(mentionsAfter, params.mentionCountsBefore)
      : null;
    const providerRequests = summarizeToolSearchProviderRequests(requests, params.targetTool);
    const redactedLogs = redactQaGatewayDebugText(params.readGatewayLogs());
    const safeLogs = formatQaGatewayLogsForError(
      sliceUtf16Safe(redactedLogs, -TOOL_SEARCH_FAILURE_LOG_CHARS),
    );
    const errorMessage = error instanceof Error ? error.message : "";
    const httpStatus = /^HTTP (\d{3})\b/u.exec(errorMessage)?.[1];
    const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const safeFailure = httpStatus
      ? `HTTP ${httpStatus}`
      : errorCode === "ETIMEDOUT" || errorCode === "ETOOBIG"
        ? errorCode
        : "request failed";
    throw new Error(
      `Tool Search ${params.lane} lane gateway request failed (${safeFailure}); ` +
        `providerRequests=${JSON.stringify(providerRequests)}; ` +
        `sessionMentions=${JSON.stringify(sessionMentions)}${safeLogs}`,
      { cause: error },
    );
  }
}
