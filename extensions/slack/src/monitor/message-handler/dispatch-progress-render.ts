import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

// Keep this policy before the compositor: native task rows cannot be removed
// after publication, and text-only filtering would miss both card renderers.
export function buildSlackProgressEventLine(
  entry: Parameters<typeof buildChannelProgressDraftLineForEntry>[0],
  input: Parameters<typeof buildChannelProgressDraftLineForEntry>[1],
  options: Parameters<typeof buildChannelProgressDraftLineForEntry>[2],
  quietProgress: boolean,
): ChannelProgressDraftLine | undefined {
  const line = buildChannelProgressDraftLineForEntry(entry, input, options);
  if (!quietProgress || (input.event !== "command-output" && input.event !== "item")) {
    return line;
  }
  const command =
    input.event === "command-output" ||
    input.commandBearing === true ||
    normalizeOptionalLowercaseString(input.itemKind) === "command" ||
    ["bash", "exec", "shell"].includes(normalizeOptionalLowercaseString(input.name) ?? "");
  if (!command) {
    return line;
  }
  const status = normalizeOptionalLowercaseString(input.status);
  // Unknown/action-required states are not routine command failures. In
  // particular, preserve blocked even when an exit code accompanies it.
  if (
    status &&
    !["failed", "error", "completed"].includes(status) &&
    !/^exit -?\d+$/u.test(status)
  ) {
    return line;
  }
  if (input.event === "command-output" && input.exitCode != null) {
    return Number.isSafeInteger(input.exitCode) && input.exitCode !== 0 ? undefined : line;
  }
  const exitStatus = status?.match(/^exit (-?\d+)$/u)?.[1];
  const failed =
    status === "failed" ||
    status === "error" ||
    (exitStatus !== undefined &&
      Number.isSafeInteger(Number(exitStatus)) &&
      Number(exitStatus) !== 0);
  return failed ? undefined : line;
}

export function resolveStructuredProgressLines(
  lines: readonly ChannelProgressDraftCompositorLine[],
): ChannelProgressDraftLine[] {
  return lines.map((line) => {
    if (typeof line !== "string") {
      return line;
    }
    const reasoning = line.startsWith("🧠 ");
    const text = line
      .replace(/^(?:🧠|💬)\s+/u, "")
      .replace(/^_(.*)_$/su, "$1")
      .trim();
    return {
      // Reasoning snapshots replace one rolling row; text-based ids would orphan it each delta.
      ...(reasoning ? { id: "reasoning" } : {}),
      kind: "item",
      text,
      label: reasoning ? "Reasoning" : "Update",
      prefix: false,
    };
  });
}

export function resolveNativeProgressLines(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): ChannelProgressDraftLine[] {
  const lines = resolveStructuredProgressLines(snapshot.lines).filter(
    (line) => line.id !== "reasoning" && line.id?.startsWith("commentary:") !== true,
  );
  if (snapshot.plan?.length || !snapshot.planExplanation) {
    return lines;
  }
  const explanationLine = buildChannelProgressDraftLine({
    event: "plan",
    phase: "update",
    explanation: snapshot.planExplanation,
  });
  return explanationLine ? [...lines, explanationLine] : lines;
}

// The card title already displays the status headline and plan explanation and
// keeps updating them in place, so narration carries only authored commentary
// and reasoning. Including them here streamed every headline a second time as
// static text above the card.
export function resolveNativeProgressNarration(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): string | undefined {
  const paragraphs = resolveStructuredProgressLines(snapshot.lines)
    .filter((line) => line.id === "reasoning" || line.id?.startsWith("commentary:") === true)
    .map((line) => line.text.trim())
    .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index);
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
}

export function combineProgressHeadlineAndExplanation(
  headline: string | undefined,
  explanation: string | undefined,
): string | undefined {
  return headline && explanation && headline !== explanation
    ? `${headline} — ${explanation}`
    : (headline ?? explanation);
}
