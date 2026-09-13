import { expectDefined } from "@openclaw/normalization-core";
import {
  composeRedactionEdits,
  rebaseRedactionEdits,
  type RedactionEdit,
} from "./redact-edit-composition.js";
import {
  iterateRedactMatches,
  type RedactMatch,
  type ResolvedRedactPattern,
} from "./redact-pattern-runtime.js";

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
  finish: (text: string) => string;
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
  projectedEdits: RedactionEdit[];
  currentValue: string;
  currentStart: number;
  currentEnd: number;
  currentRaw?: string;
  encodedEdits?: EncodedEdit[];
  pending?: RedactionEdit[];
};

type EncodedEdit = {
  start: number;
  end: number;
  decodedStart: number;
  decodedEnd: number;
  sourceEnd: number;
  sourceDecodedEnd: number;
  replacement: string;
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
      projectedEdits: [],
      currentValue: value,
      currentStart: start,
      currentEnd: end,
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

type ProjectedEdit = RedactionEdit & { scalar: boolean };

function projectMessageEdits(
  input: string,
  tokens: ScalarToken[],
  message: RedactionMessage,
  getEdits: (token: ScalarToken) => RedactionEdit[],
): ProjectedEdit[] {
  const parts = new Map(message.parts.map((part) => [part.key, part]));
  const projected: ProjectedEdit[] = [];
  for (const token of tokens) {
    if (!token.isKey && token.path.length === 1 && token.key === "message") {
      continue;
    }
    const part = token.rootKey === undefined ? undefined : parts.get(token.rootKey);
    if (!part) {
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
    const edits = getEdits(token);
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
        projected.push({
          start,
          end: Math.min(end, message.contentLength),
          replacement,
          scalar: part.json && !token.string,
        });
      }
    }
  }
  return projected.toSorted((left, right) => left.start - right.start || left.end - right.end);
}

function firstIntersectingToken(tokens: ScalarToken[], start: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(tokens[middle], "bounded JSON token search").currentEnd <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function updateCurrentToken(input: string, token: ScalarToken): void {
  const parts: string[] = [];
  const encodedEdits: EncodedEdit[] = [];
  let cursor = token.start + (token.string ? 1 : 0);
  let encodedLength = 0;
  let decodedShift = 0;
  for (const edit of token.edits) {
    const start = token.string
      ? encodedBoundary(input, token, edit.start)
      : token.start + edit.start;
    const end = token.string ? encodedBoundary(input, token, edit.end) : token.start + edit.end;
    const replacement = JSON.stringify(edit.replacement).slice(1, -1);
    const encodedStart = encodedLength + start - cursor;
    const encodedEnd = encodedStart + replacement.length;
    encodedEdits.push({
      start: encodedStart,
      end: encodedEnd,
      decodedStart: edit.start + decodedShift,
      decodedEnd: edit.start + decodedShift + edit.replacement.length,
      sourceEnd: end,
      sourceDecodedEnd: edit.end,
      replacement,
    });
    parts.push(input.slice(cursor, start), replacement);
    encodedLength = encodedEnd;
    decodedShift += edit.replacement.length - (edit.end - edit.start);
    cursor = end;
  }
  parts.push(input.slice(cursor, token.end - (token.string ? 1 : 0)));
  token.currentRaw = `"${parts.join("")}"`;
  token.encodedEdits = encodedEdits;
}

function currentDecodedBoundary(
  input: string,
  token: ScalarToken,
  position: number,
  replacements: Map<string, Map<number, number>>,
): number | undefined {
  const offset = position - token.currentStart - 1;
  const edits = token.encodedEdits;
  if (!edits) {
    return decodedBoundary(input, token, token.start + 1 + offset);
  }
  let low = 0;
  let high = edits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expectDefined(edits[middle], "current encoded edit").end < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const edit = edits[low];
  if (edit && offset >= edit.start) {
    const within = offset - edit.start;
    if (!edit.replacement.includes("\\")) {
      return edit.decodedStart + within;
    }
    let boundaries = replacements.get(edit.replacement);
    if (!boundaries) {
      boundaries = new Map();
      let decoded = 0;
      for (let encoded = 0; encoded < edit.replacement.length; decoded += 1) {
        boundaries.set(encoded, decoded);
        encoded +=
          edit.replacement[encoded] === "\\" ? (edit.replacement[encoded + 1] === "u" ? 6 : 2) : 1;
      }
      boundaries.set(edit.replacement.length, decoded);
      replacements.set(edit.replacement, boundaries);
    }
    const decoded = boundaries.get(within);
    return decoded === undefined ? undefined : edit.decodedStart + decoded;
  }
  const previous = edits[low - 1];
  const original = offset + (previous ? previous.sourceEnd - previous.end : token.start + 1);
  const decoded = decodedBoundary(input, token, original);
  return decoded === undefined
    ? undefined
    : decoded + (previous ? previous.decodedEnd - previous.sourceDecodedEnd : 0);
}

function commitPatternEdits(input: string, token: ScalarToken): boolean {
  const pending = token.pending;
  token.pending = undefined;
  if (!pending) {
    return false;
  }
  const edits = mergeRedactionEdits(pending);
  const value = applyRedactionEdits(token.currentValue, edits);
  if (value === token.currentValue) {
    return false;
  }
  token.edits = composeRedactionEdits(token.value.length, token.edits, edits);
  token.currentValue = value;
  updateCurrentToken(input, token);
  return true;
}

function changedRedactionEdits(
  previous: RedactionEdit[],
  current: RedactionEdit[],
): RedactionEdit[] {
  let index = 0;
  return current.filter((edit) => {
    while (
      previous[index] &&
      expectDefined(previous[index], "previous configured edit").start < edit.start
    ) {
      index += 1;
    }
    const before = previous[index];
    return (
      !before ||
      before.start !== edit.start ||
      before.end !== edit.end ||
      before.replacement !== edit.replacement
    );
  });
}

function commitOriginalEdits(input: string, token: ScalarToken, edits: RedactionEdit[]): boolean {
  if (edits.length === 0) {
    return false;
  }
  const combined = mergeRedactionEdits([...token.edits, ...edits]);
  const value = applyRedactionEdits(token.value, combined);
  if (value === token.currentValue) {
    return false;
  }
  token.edits = combined;
  token.currentValue = value;
  updateCurrentToken(input, token);
  return true;
}

function updateCurrentRecord(
  current: string,
  tokens: ScalarToken[],
  changed: ReadonlySet<ScalarToken>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  let shift = 0;
  for (const token of tokens) {
    const start = token.currentStart;
    const end = token.currentEnd;
    if (changed.has(token)) {
      const raw = expectDefined(token.currentRaw, "changed JSON token");
      parts.push(current.slice(cursor, start), raw);
      cursor = end;
      token.currentStart = start + shift;
      shift += raw.length - (end - start);
    } else {
      token.currentStart = start + shift;
    }
    token.currentEnd = end + shift;
  }
  parts.push(current.slice(cursor));
  return parts.join("");
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
  prepEdits: (field: RedactionField) => RedactionEdit[],
  messageKeys?: ReadonlySet<string>,
  message?: RedactionMessage,
  serializedInput = false,
): string {
  const tokens = readScalarTokens(input, messageKeys);
  const messageToken = message
    ? tokens.find((token) => !token.isKey && token.path.length === 1 && token.key === "message")
    : undefined;
  const replacementBoundaries = new Map<string, Map<number, number>>();
  let projectedMessageEdits: RedactionEdit[] = [];
  let projectedMessageValue = messageToken?.value ?? "";
  let current = input;
  const prepared = new Set<ScalarToken>();
  for (const token of tokens) {
    if (commitOriginalEdits(input, token, prepEdits(token))) {
      prepared.add(token);
    }
  }
  if (prepared.size > 0) {
    current = updateCurrentRecord(current, tokens, prepared);
  }
  const conditionalProtected = new Set<ScalarToken>();
  const projectMessage = (): boolean => {
    if (!messageToken || !message) {
      return false;
    }
    const projected = projectMessageEdits(input, tokens, message, (token) => {
      const edits = changedRedactionEdits(token.projectedEdits, token.edits);
      token.projectedEdits = token.edits;
      return edits;
    });
    if (projected.length === 0) {
      return false;
    }
    const sourceEdits = rebaseRedactionEdits(projectedMessageEdits, projected);
    const messageEdits = rebaseRedactionEdits(messageToken.edits, projected);
    let generatedIndex = 0;
    for (let index = 0; index < messageEdits.length; index += 1) {
      const edit = expectDefined(messageEdits[index], "projected message edit");
      const sourceEdit = expectDefined(sourceEdits[index], "projected source edit");
      const projection = expectDefined(projected[index], "source projection");
      while (
        messageToken.edits[generatedIndex] &&
        expectDefined(messageToken.edits[generatedIndex], "generated message span").start <
          projection.start
      ) {
        generatedIndex += 1;
      }
      const generated = messageToken.edits[generatedIndex];
      const scalarPromotion =
        projection.scalar &&
        generated?.start === projection.start &&
        generated.end === projection.end &&
        edit.replacement === JSON.stringify(generated.replacement);
      const before = messageToken.currentValue.slice(edit.start, edit.end);
      if (
        !scalarPromotion &&
        before !== edit.replacement &&
        before !== projectedMessageValue.slice(sourceEdit.start, sourceEdit.end)
      ) {
        // A source update cannot restore text hidden by a message-only rule.
        edit.replacement = projection.scalar ? JSON.stringify("***") : "***";
      }
    }
    messageToken.pending = messageEdits;
    projectedMessageValue = applyRedactionEdits(projectedMessageValue, sourceEdits);
    projectedMessageEdits = composeRedactionEdits(
      messageToken.value.length,
      projectedMessageEdits,
      sourceEdits,
    );
    return commitPatternEdits(input, messageToken);
  };
  // Preserve the first matching representation used by each transport before adding the other.
  for (let phase = 0; phase < 2; phase += 1) {
    const decoded = serializedInput ? phase === 1 : phase === 0;
    for (const pattern of patterns) {
      let pending: Set<ScalarToken> | undefined;
      const add = (token: ScalarToken, edit: RedactionEdit) => {
        (token.pending ??= []).push(edit);
        (pending ??= new Set()).add(token);
      };
      if (decoded) {
        for (const token of tokens) {
          if (token.isKey) {
            continue;
          }
          const value = token.currentValue;
          for (const match of iterateRedactMatches(value, pattern)) {
            const edit = getEdit(match, pattern, (start, end) => ({
              start,
              end,
              value: value.slice(start, end),
              key: token.key,
              fieldValue: value,
            }));
            if (!edit || edit.end <= edit.start) {
              continue;
            }
            add(
              token,
              !token.string && token.edits.length === 0
                ? { start: 0, end: value.length, replacement: "***" }
                : edit,
            );
          }
        }
      } else {
        for (const match of iterateRedactMatches(current, pattern)) {
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
            if (token.currentStart >= capture.end) {
              break;
            }
            const value = token.currentValue;
            if (!token.string && token.edits.length === 0) {
              add(token, { start: 0, end: value.length, replacement: "***" });
              continue;
            }
            const start = currentDecodedBoundary(
              input,
              token,
              Math.max(capture.start, token.currentStart + 1),
              replacementBoundaries,
            );
            const end = currentDecodedBoundary(
              input,
              token,
              Math.min(capture.end, token.currentEnd - 1),
              replacementBoundaries,
            );
            // Cutting an escape cannot leave the rest of a quoted credential visible.
            if (start === undefined || end === undefined || end <= start) {
              add(token, { start: 0, end: value.length, replacement: "***" });
              continue;
            }
            const edit = getEdit(match, pattern, () => ({
              start,
              end,
              value: value.slice(start, end),
              key: token.key,
              fieldValue: value,
            }));
            if (edit) {
              add(token, edit);
            }
          }
        }
      }
      if (!pending) {
        continue;
      }
      for (const token of pending) {
        if (!commitPatternEdits(input, token)) {
          pending.delete(token);
        }
      }
      if (pending.size > 0) {
        current = updateCurrentRecord(current, tokens, pending);
      }
    }
    const changed = new Set<ScalarToken>();
    for (const token of tokens) {
      if (phase === 0 && commitOriginalEdits(input, token, fieldEdits(token))) {
        changed.add(token);
      }
      if (token.string && !conditionalProtected.has(token)) {
        const edits = conditionalEdits(token, token.edits.length > 0);
        if (edits.length > 0) {
          conditionalProtected.add(token);
          if (commitOriginalEdits(input, token, edits)) {
            changed.add(token);
          }
        }
      }
    }
    if (projectMessage() && messageToken) {
      changed.add(messageToken);
    }
    if (changed.size > 0) {
      current = updateCurrentRecord(current, tokens, changed);
    }
  }
  if (messageToken && message) {
    const finished = message.finish(messageToken.currentValue);
    if (finished !== messageToken.currentValue) {
      return applyRedactionEdits(current, [
        {
          start: messageToken.currentStart,
          end: messageToken.currentEnd,
          replacement: JSON.stringify(finished),
        },
      ]);
    }
  }
  return current;
}
