import { describe, expect, it } from "vitest";
import { requestToolSearchGatewayResponse } from "./tool-search-gateway-request-evidence.js";

describe("Tool Search provider request evidence", () => {
  const targetTool = "fake_plugin_tool_17";

  async function summarize(requests: unknown, requestedTarget = targetTool) {
    const fetchJson = async (url: string) => {
      if (url.endsWith("/v1/responses")) {
        throw new Error("HTTP 502: fixture failure");
      }
      return requests;
    };
    const error = await requestToolSearchGatewayResponse({
      fetchJson,
      gatewayBaseUrl: "http://gateway.test",
      gatewayToken: "test-token",
      lane: "code",
      mentionCountsBefore: {},
      providerBaseUrl: "http://provider.test",
      requestCursorBefore: 0,
      readGatewayLogs: () => "",
      sessionKey: "test-session",
      stateDir: "/nonexistent-tool-search-state",
      targetTool: requestedTarget,
      timeoutMs: 1_000,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const serialized = /providerRequests=(\[.*\]); sessionMentions=/u.exec(
      (error as Error).message,
    )?.[1];
    expect(serialized).toBeDefined();
    return JSON.parse(serialized ?? "[]") as Array<Record<string, unknown>>;
  }

  it("projects wrapped OpenAI and flat Anthropic tool declarations into stage-only fields", async () => {
    await expect(
      summarize([
        {
          body: {
            tools: [
              { type: "function", function: { name: targetTool } },
              { type: "function", function: { name: "tool_search_code" } },
            ],
          },
          plannedToolName: targetTool,
        },
        {
          body: {
            tools: [
              { name: targetTool, input_schema: { type: "object" } },
              { name: "tool_search_code", input_schema: { type: "object" } },
            ],
          },
          plannedToolName: "tool_search_code",
          toolOutput: `FAKE_PLUGIN_OK ${targetTool} private output`,
        },
      ]),
    ).resolves.toEqual([
      {
        plannedToolName: targetTool,
        declaredToolCount: 2,
        targetDeclared: true,
        bridgeDeclared: true,
        targetResultObserved: false,
      },
      {
        plannedToolName: "tool_search_code",
        declaredToolCount: 2,
        targetDeclared: true,
        bridgeDeclared: true,
        targetResultObserved: true,
      },
    ]);
  });

  it("treats malformed snapshots as absent stage evidence", async () => {
    await expect(summarize({ requests: [] })).resolves.toEqual([]);
    await expect(summarize([null, [], { body: { tools: [null, 42] } }])).resolves.toEqual([
      {
        plannedToolName: null,
        declaredToolCount: 0,
        targetDeclared: false,
        bridgeDeclared: false,
        targetResultObserved: false,
      },
      {
        plannedToolName: null,
        declaredToolCount: 0,
        targetDeclared: false,
        bridgeDeclared: false,
        targetResultObserved: false,
      },
      {
        plannedToolName: null,
        declaredToolCount: 2,
        targetDeclared: false,
        bridgeDeclared: false,
        targetResultObserved: false,
      },
    ]);
  });

  it("keeps only the latest request window and never returns raw diagnostic text", async () => {
    const secrets = {
      body: "raw-body-secret",
      prompt: "raw-prompt-secret",
      output: "raw-tool-output-secret",
      planned: "raw-planned-tool-secret",
    };
    const requests = Array.from({ length: 14 }, (_, index) => ({
      body: { tools: index === 2 ? [{ name: "tool_search_code" }] : [] },
      plannedToolName: index < 2 ? "tool_call" : index === 2 ? "tool_search" : secrets.planned,
      raw: secrets.body,
      prompt: secrets.prompt,
      toolOutput: secrets.output,
    }));

    const summary = await summarize(requests);
    expect(summary).toHaveLength(12);
    expect(summary[0]).toMatchObject({
      plannedToolName: "tool_search",
      bridgeDeclared: true,
    });
    expect(summary.at(-1)?.plannedToolName).toBe("<other>");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secrets.body);
    expect(serialized).not.toContain(secrets.prompt);
    expect(serialized).not.toContain(secrets.output);
    expect(serialized).not.toContain(secrets.planned);
  });
});
