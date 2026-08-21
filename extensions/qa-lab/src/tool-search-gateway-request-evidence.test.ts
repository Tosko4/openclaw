import { describe, expect, it } from "vitest";
import {
  projectToolSearchGatewayLogFacts,
  projectToolSearchProviderRequests,
} from "./tool-search-gateway-request-evidence.js";

describe("Tool Search provider request evidence", () => {
  const targetTool = "fake_plugin_tool_17";

  const absentStage = {
    plannedToolName: null,
    declaredToolCount: 0,
    targetDeclared: false,
    bridgeDeclared: false,
    targetResultObserved: false,
  };

  it.each([
    {
      label: "wrapped OpenAI",
      tools: [
        { type: "function", function: { name: targetTool } },
        { type: "function", function: { name: "tool_search_code" } },
      ],
      plannedToolName: targetTool,
      targetResultObserved: false,
    },
    {
      label: "flat Anthropic",
      tools: [
        { name: targetTool, input_schema: { type: "object" } },
        { name: "tool_search_code", input_schema: { type: "object" } },
      ],
      plannedToolName: "tool_search_code",
      targetResultObserved: true,
    },
  ])("projects $label declarations into stage-only fields", (testCase) => {
    expect(
      projectToolSearchProviderRequests(
        [
          {
            body: { tools: testCase.tools },
            plannedToolName: testCase.plannedToolName,
            toolOutput: testCase.targetResultObserved
              ? `FAKE_PLUGIN_OK ${targetTool} private output`
              : undefined,
          },
        ],
        targetTool,
      ),
    ).toEqual([
      {
        plannedToolName: testCase.plannedToolName,
        declaredToolCount: 2,
        targetDeclared: true,
        bridgeDeclared: true,
        targetResultObserved: testCase.targetResultObserved,
      },
    ]);
  });

  it("treats malformed snapshots as absent stage evidence", () => {
    expect(projectToolSearchProviderRequests({ requests: [] }, targetTool)).toEqual([]);
    expect(
      projectToolSearchProviderRequests([null, [], { body: { tools: [null, 42] } }], targetTool),
    ).toEqual([absentStage, absentStage, { ...absentStage, declaredToolCount: 2 }]);
  });

  it("keeps only the latest request window and never returns raw diagnostic text", () => {
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

    const summary = projectToolSearchProviderRequests(requests, targetTool);
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

  it("projects only allowlisted Gateway log facts", () => {
    const prompt = "arbitrary prompt sentinel";
    const output = "arbitrary tool output sentinel";
    const facts = projectToolSearchGatewayLogFacts(
      `${prompt}\ntool_search_code\n${targetTool}\n${output}`,
      targetTool,
    );

    expect(facts).toEqual({
      captured: true,
      mentions: {
        tool_search_code: true,
        tool_search: true,
        tool_describe: false,
        tool_call: false,
        [targetTool]: true,
      },
    });
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(output);
  });
});
