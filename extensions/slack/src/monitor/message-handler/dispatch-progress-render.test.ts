import { describe, expect, it } from "vitest";
import { buildSlackProgressEventLine } from "./dispatch-progress-render.js";

type Event = Parameters<typeof buildSlackProgressEventLine>[1];
const render = (event: Event, quiet = true) =>
  buildSlackProgressEventLine({}, event, undefined, quiet);

describe("Slack command-failure visibility", () => {
  const failures: Event[] = [
    ...["exec", "Bash", " SHELL "].map((name): Event => ({
      event: "item",
      name,
      status: "failed",
    })),
    { event: "item", itemKind: "command", status: "error" },
    { event: "item", name: "mcp__openclaw__exec", commandBearing: true, status: "failed" },
    { event: "item", name: "functions.exec", commandBearing: true, status: "exit 8" },
    { event: "command-output", phase: "end", name: "Bash", exitCode: 1 },
    { event: "command-output", phase: "end", exitCode: 8, status: "completed" },
    { event: "command-output", phase: "end", exitCode: -1 },
    { event: "command-output", phase: "end", status: "failed" },
    { event: "command-output", phase: "end", status: "error", exitCode: null },
    { event: "command-output", phase: "end", status: "exit 2" },
  ];
  it.each(failures)("hides only quiet command outcome %j", (event) => {
    expect(render(event)).toBeUndefined();
    expect(render(event, false)).toBeDefined();
  });

  it.each<Event>([
    { event: "approval", phase: "requested", approvalId: "a1", command: "Run checks" },
    { event: "item", name: "exec", status: "blocked" },
    { event: "command-output", phase: "end", exitCode: 1, status: "blocked" },
    { event: "command-output", phase: "end", exitCode: 1, status: "approval_required" },
    { event: "command-output", phase: "end", exitCode: 1, status: "unknown" },
    { event: "command-output", phase: "end", exitCode: Number.NaN, status: "failed" },
    { event: "command-output", phase: "end", exitCode: Infinity },
    { event: "command-output", phase: "end", exitCode: 1.5 },
    { event: "command-output", phase: "end", status: "exit unknown" },
    { event: "command-output", phase: "end", status: "exit 1.5" },
    { event: "command-output", phase: "end", status: "exit 9007199254740993" },
    { event: "command-output", phase: "end", exitCode: 0 },
    { event: "item", name: "exec", status: "completed" },
    { event: "item", name: "read", status: "failed" },
    { event: "item", name: "api", status: "error" },
    { event: "item", name: "unknown_command", status: "failed" },
    { event: "item", name: "mcp__unknown__exec", status: "failed" },
  ])("preserves approvals, unknown outcomes and unrelated errors %j", (event) => {
    expect(render(event)).toEqual(render(event, false));
    expect(render(event)).toBeDefined();
  });
});
