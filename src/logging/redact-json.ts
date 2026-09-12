import { expectDefined } from "@openclaw/normalization-core";
import {
  iterateRedactMatches,
  type RedactMatch,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";

export type RedactionEdit = { start: number; end: number; replacement: string };
export type RedactionTarget = {
  start: number;
  end: number;
  value: string;
  key?: string;
  fieldValue?: string;
};
export type RedactionField = {
  key: string;
  path: readonly string[];
  objectPath: boolean;
  messagePart: boolean;
  isKey: boolean;
  string: boolean;
  value: string;
};
export type RedactionMessage = {
  text: string;
  contentLength: number;
  parts: {
    key: string;
    json: boolean;
    messageField: boolean;
    start: number;
  }[];
};

function mergeRedactionEdits(edits: RedactionEdit[]): RedactionEdit[] {
  edits.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: RedactionEdit[] = [];
  for (const edit of edits) {
    const previous = merged.at(-1);
    if (!previous || edit.start >= previous.end) {
      merged.push({ ...edit });
    } else if (
      edit.start !== previous.start ||
      edit.end !== previous.end ||
      edit.replacement !== previous.replacement
    ) {
      previous.end = Math.max(previous.end, edit.end);
      // Conflicting captures cannot retain a hint exposing another captured value.
      previous.replacement = "***";
    }
  }
  return merged;
}

function applyRedactionEdits(value: string, edits: RedactionEdit[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of mergeRedactionEdits(edits)) {
    parts.push(value.slice(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  return parts.join("") + value.slice(cursor);
}

type ScalarToken = RedactionField & {
  start: number;
  end: number;
  escaped: boolean;
  boundaries?: Map<number, number>;
  encodedBoundaries?: number[];
  rootKey?: string;
  rootValueStart?: number;
  edits: RedactionEdit[];
  fullMask: boolean;
};

type FieldContext = Pick<RedactionField, "key" | "path" | "objectPath" | "messagePart"> & {
  rootKey?: string;
  rootValueStart?: number;
};
type JsonContainer = {
  array: boolean;
  context: FieldContext;
  field?: FieldContext;
};

const JSON_TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]]/g;

function readScalarTokens(text: string, messageKeys?: ReadonlySet<string>): ScalarToken[] {
  const tokens: ScalarToken[] = [];
  const containers: JsonContainer[] = [];
  const root: FieldContext = { key: "", path: [], objectPath: true, messagePart: false };
  const valueContext = (parent: JsonContainer | undefined): FieldContext =>
    !parent
      ? root
      : parent.array
        ? parent.context
        : expectDefined(parent.field, "JSON object field context");
  for (const match of text.matchAll(JSON_TOKEN_RE)) {
    const raw = match[0];
    const parent = containers.at(-1);
    if (raw === "{" || raw === "[") {
      const context = valueContext(parent);
      const array = raw === "[";
      containers.push({
        array,
        context: array ? { ...context, objectPath: false } : context,
      });
      continue;
    }
    if (raw === "}" || raw === "]") {
      containers.pop();
      continue;
    }
    const start = match.index;
    const end = start + raw.length;
    const string = raw.startsWith('"');
    const value: string = string ? JSON.parse(raw) : raw;
    let next = end;
    while (
      text[next] === " " ||
      text[next] === "\t" ||
      text[next] === "\r" ||
      text[next] === "\n"
    ) {
      next += 1;
    }
    const isKey = string && text[next] === ":";
    let context: FieldContext;
    if (isKey) {
      const container = expectDefined(parent, "JSON property container");
      const inherited = container.context;
      context = {
        key: "",
        path: [],
        objectPath: false,
        messagePart: inherited.messagePart,
        rootKey: inherited.rootKey,
        rootValueStart: inherited.rootValueStart,
      };
      let valueStart = next + 1;
      while (
        text[valueStart] === " " ||
        text[valueStart] === "\t" ||
        text[valueStart] === "\r" ||
        text[valueStart] === "\n"
      ) {
        valueStart += 1;
      }
      container.field = {
        key: value,
        path: [...inherited.path, value],
        objectPath: inherited.objectPath,
        messagePart:
          inherited.messagePart ||
          (inherited.path.length === 0 && messageKeys?.has(value) === true),
        rootKey: containers.length === 1 ? value : inherited.rootKey,
        rootValueStart: containers.length === 1 ? valueStart : inherited.rootValueStart,
      };
    } else {
      context = valueContext(parent);
    }
    tokens.push({
      ...context,
      start,
      end,
      isKey,
      string,
      value,
      escaped: string && raw.includes("\\"),
      edits: [],
      fullMask: false,
    });
  }
  return tokens;
}

function stringBoundaries(text: string, token: ScalarToken): Map<number, number> {
  const boundaries = new Map<number, number>();
  let decoded = 0;
  for (let offset = token.start + 1; offset < token.end - 1; decoded += 1) {
    boundaries.set(offset, decoded);
    offset += text[offset] === "\\" ? (text[offset + 1] === "u" ? 6 : 2) : 1;
  }
  boundaries.set(token.end - 1, decoded);
  return boundaries;
}

function decodedBoundary(text: string, token: ScalarToken, offset: number): number | undefined {
  if (!token.escaped) {
    return offset - token.start - 1;
  }
  token.boundaries ??= stringBoundaries(text, token);
  return token.boundaries.get(offset);
}

function encodedBoundary(text: string, token: ScalarToken, offset: number): number {
  if (!token.escaped) {
    return token.start + 1 + offset;
  }
  if (!token.encodedBoundaries) {
    token.boundaries ??= stringBoundaries(text, token);
    token.encodedBoundaries = [];
    for (const [encoded, decoded] of token.boundaries) {
      token.encodedBoundaries[decoded] = encoded;
    }
  }
  return expectDefined(token.encodedBoundaries[offset], "decoded JSON edit boundary");
}

function projectMessageEdits(
  input: string,
  tokens: ScalarToken[],
  message: RedactionMessage,
): void {
  const parts = new Map(message.parts.map((part) => [part.key, part]));
  const projected: RedactionEdit[] = [];
  let messageToken: ScalarToken | undefined;
  for (const token of tokens) {
    if (!token.isKey && token.path.length === 1 && token.key === "message") {
      messageToken = token;
      continue;
    }
    const part = token.rootKey === undefined ? undefined : parts.get(token.rootKey);
    if (!part || (!token.fullMask && token.edits.length === 0)) {
      continue;
    }
    if (
      !part.json &&
      (token.isKey ||
        (part.messageField
          ? token.path.length !== 2 || token.key !== "message"
          : token.path.length !== 1))
    ) {
      continue;
    }
    const edits = token.fullMask
      ? [{ start: 0, end: token.value.length, replacement: "***" }]
      : token.edits;
    for (const edit of edits) {
      let start: number;
      let end: number;
      let replacement = edit.replacement;
      if (part.json) {
        const base = part.start - expectDefined(token.rootValueStart, "displayed JSON argument");
        if (token.string) {
          start = base + encodedBoundary(input, token, edit.start);
          end = base + encodedBoundary(input, token, edit.end);
          replacement = JSON.stringify(replacement).slice(1, -1);
        } else {
          start = base + token.start;
          end = base + token.end;
          replacement = JSON.stringify(replacement);
        }
      } else {
        start = part.start + edit.start;
        end = part.start + edit.end;
      }
      if (start < message.contentLength) {
        projected.push({ start, end: Math.min(end, message.contentLength), replacement });
      }
    }
  }
  if (messageToken && !messageToken.fullMask) {
    messageToken.edits.push(...projected);
  }
}

function firstIntersectingToken(tokens: ScalarToken[], start: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(tokens[middle], "bounded JSON token search").end <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function redactJsonRecord(
  input: string,
  patterns: ResolvedRedactPattern[],
  getEdit: (
    match: RedactMatch,
    pattern: ResolvedRedactPattern,
    project: (start: number, end: number) => RedactionTarget | undefined,
  ) => RedactionEdit | undefined,
  conditionalEdits: (field: RedactionField, changed: boolean) => RedactionEdit[],
  fieldEdits: (field: RedactionField) => RedactionEdit[],
  messageKeys?: ReadonlySet<string>,
  message?: RedactionMessage,
): string {
  const tokens = readScalarTokens(input, messageKeys);
  for (const token of tokens) {
    token.edits = fieldEdits(token);
    token.fullMask = !token.string && token.edits.length > 0;
  }
  // Both matching surfaces retain their original offsets until all captures are composed.
  for (const pattern of patterns) {
    for (const token of tokens) {
      if (token.isKey) {
        continue;
      }
      const { value } = token;
      for (const match of iterateRedactMatches(value, pattern)) {
        const edit = getEdit(match, pattern, (start, end) => ({
          start,
          end,
          value: value.slice(start, end),
          key: token.key,
          fieldValue: token.value,
        }));
        if (!edit || edit.end <= edit.start) {
          continue;
        }
        if (!token.string) {
          token.fullMask = true;
        } else {
          token.edits.push(edit);
        }
      }
    }
    for (const match of iterateRedactMatches(input, pattern)) {
      let capture: { start: number; end: number } | undefined;
      getEdit(match, pattern, (start, end) => {
        capture = { start, end };
        return undefined;
      });
      if (!capture || capture.end <= capture.start) {
        continue;
      }
      for (
        let index = firstIntersectingToken(tokens, capture.start);
        index < tokens.length;
        index += 1
      ) {
        const token = expectDefined(tokens[index], "bounded JSON token capture");
        if (token.start >= capture.end) {
          break;
        }
        if (!token.string) {
          token.fullMask = true;
          continue;
        }
        const { value } = token;
        const start = decodedBoundary(input, token, Math.max(capture.start, token.start + 1));
        const end = decodedBoundary(input, token, Math.min(capture.end, token.end - 1));
        // Cutting an escape cannot leave the rest of a quoted credential visible.
        if (start === undefined || end === undefined || end <= start) {
          token.fullMask = true;
          continue;
        }
        const edit = getEdit(match, pattern, () => ({
          start,
          end,
          value: value.slice(start, end),
          key: token.key,
          fieldValue: token.value,
        }));
        if (edit) {
          token.edits.push(edit);
        }
      }
    }
  }
  for (const token of tokens) {
    if (token.string) {
      token.edits.push(...conditionalEdits(token, token.fullMask || token.edits.length > 0));
    }
    token.edits = mergeRedactionEdits(token.edits);
  }
  if (message) {
    projectMessageEdits(input, tokens, message);
  }
  const edits: RedactionEdit[] = [];
  for (const token of tokens) {
    if (token.fullMask) {
      edits.push({ start: token.start, end: token.end, replacement: '"***"' });
    } else if (token.edits.length > 0) {
      edits.push({
        start: token.start,
        end: token.end,
        replacement: JSON.stringify(applyRedactionEdits(token.value, token.edits)),
      });
    }
  }
  return applyRedactionEdits(input, edits);
}
