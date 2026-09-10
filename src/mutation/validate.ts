/**
 * Strict request validation (spec §15).
 *
 * Before touching the filesystem, reject malformed anchors, unknown fields,
 * empty/malformed ranges, newline-bearing line values, unsupported control
 * bytes, and invalid shapes. No normalization changes semantic content:
 * the engine either rejects or warns-but-applies; it never guesses.
 */

import { ANCHOR_RE, ANCHOR_CLASS } from "../anchors/alphabet";
import { isRec, rejectUnknownFields } from "../utils";
import { EXPECTED_REVISION_PATTERN } from "../constants";

export const EDIT_ROOT_KEYS = new Set([
  "path",
  "edits",
  "allow_display_like_content",
  "allow_boundary_duplicate",
  "allow_large_change",
  "final_newline",
  "expected_revision",
]);
export const EDIT_ITEM_KEYS = new Set(["range", "lines"]);

export const INSERT_ROOT_KEYS = new Set([
  "path",
  "inserts",
  "allow_display_like_content",
  "final_newline",
  "expected_revision",
]);
export const WRITE_ROOT_KEYS = new Set([
  "path",
  "content",
  "replace_existing",
  "allow_display_like_content",
  "expected_revision",
]);
export const INSERT_ITEM_KEYS = new Set(["anchor", "direction", "lines"]);

export type FinalNewline = "preserve" | "present" | "absent";

export interface EditItem {
  range: [string, string];
  lines: string[];
}

export interface EditRequest {
  path: string;
  edits: EditItem[];
  allow_display_like_content?: boolean;
  /** PH-EDIT-003: explicit top-level escape hatch for boundary duplication. */
  allow_boundary_duplicate?: boolean;
  /** PH-EDIT-008: explicit override for the large destructive edit guard. */
  allow_large_change?: boolean;
  final_newline?: FinalNewline;
  expected_revision?: string;
}

export interface InsertItem {
  anchor: string;
  direction: "before" | "after";
  lines: string[];
}

export interface InsertRequest {
  path: string;
  inserts: InsertItem[];
  allow_display_like_content?: boolean;
  final_newline?: FinalNewline;
  expected_revision?: string;
}

export interface WriteRequest {
  path: string;
  content: string;
  replace_existing?: boolean;
  allow_display_like_content?: boolean;
  expected_revision?: string;
}

/** Display-like hashline rows: `Ab31│...`, `+Ab31│...`, `-Ab31│...`, ` Ab31│...`. */
export const DISPLAY_LIKE_RE = new RegExp(`^[ +-]?${ANCHOR_CLASS}${"│"}`);

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function assertAnchor(ref: unknown, label: string): string {
  if (typeof ref !== "string" || !ANCHOR_RE.test(ref)) {
    throw new Error(
      `[E_BAD_REF] ${label} must be a bare 4-character anchor (A-Za-z0-9), e.g. "q8Bf". Copy only the anchor from the leftmost column of a read row like \`q8Bf│content\`; never include the row content or any prefix. Got: ${JSON.stringify(ref)}`,
    );
  }
  return ref;
}

export function assertPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_SHAPE] A non-empty "path" string is required.');
  }
  if (path.includes("\0")) {
    throw new Error('[E_BAD_SHAPE] "path" must not contain a NUL byte.');
  }
  return path;
}

export function assertLines(
  lines: unknown,
  label: string,
  suspiciousCheck: (line: string) => void,
): string[] {
  if (!Array.isArray(lines)) {
    throw new Error(
      `[E_BAD_SHAPE] ${label} "lines" must be an array of literal logical lines.`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== "string") {
      throw new Error(
        `[E_BAD_SHAPE] ${label} "lines" entry ${i + 1} must be a string (no \\n or \\r allowed inside a single line value).`,
      );
    }
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error(
        `[E_EMBEDDED_NEWLINE] ${label} "lines" entry ${i + 1} contains a line break. Each array entry is exactly one logical line; split it into separate entries.`,
      );
    }
    if (CONTROL_RE.test(line)) {
      throw new Error(
        `[E_BAD_SHAPE] ${label} "lines" entry ${i + 1} contains unsupported control bytes.`,
      );
    }
    if (LONE_SURROGATE_RE.test(line)) {
      throw new Error(
        `[E_BAD_SHAPE] ${label} "lines" entry ${i + 1} contains an unpaired UTF-16 surrogate.`,
      );
    }
    suspiciousCheck(line);
    out.push(line);
  }
  return out;
}

/**
 * Reject pasted hashline tool output (spec §17). The engine cannot know
 * whether the model accidentally pasted a read row or the literal file
 * really contains that text, so the correct behavior is rejecting — never
 * stripping. `allow_display_like_content: true` writes every byte literally.
 */
export function suspiciousContentCheck(
  line: string,
  allowDisplayLike: boolean,
): void {
  if (!allowDisplayLike && DISPLAY_LIKE_RE.test(line)) {
    throw new Error(
      `[E_DISPLAY_LIKE_CONTENT] Replacement content resembles hashline-rendered tool output: ${JSON.stringify(line.slice(0, 40))}. Nothing was modified. If this text is intentionally literal, resend with "allow_display_like_content": true.`,
    );
  }
}

function assertFinalNewline(value: unknown): FinalNewline | undefined {
  if (value === undefined) return undefined;
  if (value === "preserve" || value === "present" || value === "absent") {
    return value;
  }
  throw new Error(
    '[E_BAD_SHAPE] "final_newline" must be one of "preserve", "present", or "absent".',
  );
}

function assertOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`[E_BAD_SHAPE] "${field}" must be a boolean.`);
  }
  return value;
}

const EXPECTED_REVISION_RE = new RegExp(EXPECTED_REVISION_PATTERN);

function assertExpectedRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && EXPECTED_REVISION_RE.test(value)) {
    return value;
  }
  const received =
    typeof value === "string"
      ? ` Received a string of length ${value.length}.`
      : ` Received ${value === null ? "null" : typeof value}.`;
  throw new Error(
    `[E_BAD_SHAPE] "expected_revision" must be a 64-character lowercase SHA-256 hex revision as returned in tool details.${received} ` +
      'Omit "expected_revision" when CAS is unused, or copy details.revision from read/write or details.metrics.after_revision from edit/insert.',
  );
}

export function validateEditRequest(request: unknown): EditRequest {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  }
  rejectUnknownFields(request, EDIT_ROOT_KEYS, "Edit request");
  const path = assertPath(request.path);
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw new Error(
      '[E_BAD_SHAPE] Edit request requires a non-empty "edits" array.',
    );
  }
  const allowDisplayLike = assertOptionalBoolean(
    request.allow_display_like_content,
    "allow_display_like_content",
  );
  const allowBoundaryDuplicate = assertOptionalBoolean(
    request.allow_boundary_duplicate,
    "allow_boundary_duplicate",
  );
  const allowLargeChange = assertOptionalBoolean(
    request.allow_large_change,
    "allow_large_change",
  );
  const edits: EditItem[] = [];
  for (let i = 0; i < request.edits.length; i++) {
    const item = request.edits[i];
    if (!isRec(item)) {
      throw new Error(`[E_BAD_SHAPE] Edit #${i + 1} must be an object.`);
    }
    rejectUnknownFields(item, EDIT_ITEM_KEYS, `Edit #${i + 1}`);
    if (!Array.isArray(item.range) || item.range.length !== 2) {
      throw new Error(
        `[E_BAD_SHAPE] Edit #${i + 1} requires "range" as exactly two anchors: [start, end].`,
      );
    }
    const range: [string, string] = [
      assertAnchor(item.range[0], `Edit #${i + 1} range start`),
      assertAnchor(item.range[1], `Edit #${i + 1} range end`),
    ];
    if (item.lines === undefined) {
      throw new Error(`[E_BAD_SHAPE] Edit #${i + 1} requires a "lines" array.`);
    }
    const lines = assertLines(item.lines, `Edit #${i + 1}`, (line) =>
      suspiciousContentCheck(line, allowDisplayLike === true),
    );
    edits.push({ range, lines });
  }
  return {
    path,
    edits,
    allow_display_like_content: allowDisplayLike,
    allow_boundary_duplicate: allowBoundaryDuplicate,
    allow_large_change: allowLargeChange,
    final_newline: assertFinalNewline(request.final_newline),
    expected_revision: assertExpectedRevision(request.expected_revision),
  };
}

export function validateInsertRequest(request: unknown): InsertRequest {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] Insert request must be an object.");
  }
  rejectUnknownFields(request, INSERT_ROOT_KEYS, "Insert request");
  const path = assertPath(request.path);
  if (!Array.isArray(request.inserts) || request.inserts.length === 0) {
    throw new Error(
      '[E_BAD_SHAPE] Insert request requires a non-empty "inserts" array.',
    );
  }
  const allowDisplayLike = assertOptionalBoolean(
    request.allow_display_like_content,
    "allow_display_like_content",
  );
  const inserts: InsertItem[] = [];
  for (let i = 0; i < request.inserts.length; i++) {
    const item = request.inserts[i];
    if (!isRec(item)) {
      throw new Error(`[E_BAD_SHAPE] Insert #${i + 1} must be an object.`);
    }
    rejectUnknownFields(item, INSERT_ITEM_KEYS, `Insert #${i + 1}`);
    const anchor = assertAnchor(item.anchor, `Insert #${i + 1} anchor`);
    if (item.direction !== "before" && item.direction !== "after") {
      throw new Error(
        `[E_BAD_SHAPE] Insert #${i + 1} "direction" must be "before" or "after".`,
      );
    }
    if (item.lines === undefined) {
      throw new Error(
        `[E_BAD_SHAPE] Insert #${i + 1} requires a "lines" array.`,
      );
    }
    const lines = assertLines(item.lines, `Insert #${i + 1}`, (line) =>
      suspiciousContentCheck(line, allowDisplayLike === true),
    );
    inserts.push({ anchor, direction: item.direction, lines });
  }
  return {
    path,
    inserts,
    allow_display_like_content: allowDisplayLike,
    final_newline: assertFinalNewline(request.final_newline),
    expected_revision: assertExpectedRevision(request.expected_revision),
  };
}

export function validateWriteRequest(request: unknown): WriteRequest {
  if (!isRec(request)) {
    throw new Error("[E_BAD_SHAPE] write parameters must be an object.");
  }
  rejectUnknownFields(request, WRITE_ROOT_KEYS, "write request");
  const path = assertPath(request.path);
  if (typeof request.content !== "string") {
    throw new Error('[E_BAD_SHAPE] A "content" string is required.');
  }
  const replaceExisting = assertOptionalBoolean(
    request.replace_existing,
    "replace_existing",
  );
  const allowDisplayLike = assertOptionalBoolean(
    request.allow_display_like_content,
    "allow_display_like_content",
  );
  const expectedRevision = assertExpectedRevision(request.expected_revision);
  return {
    path,
    content: request.content,
    replace_existing: replaceExisting,
    allow_display_like_content: allowDisplayLike,
    expected_revision: expectedRevision,
  };
}
