/**
 * Pure mutation engine (spec §58).
 *
 * `applyTransaction` takes a document, its anchor state, and a list of
 * operations, and returns the complete result: document, anchor state,
 * diff model, and metrics. It has no filesystem, no SQLite, no Pi API, and
 * no UI — which makes fuzz/property testing practical.
 *
 * Semantics:
 * - All ranges resolve against the original document (spec §19).
 * - Operations are byte-level splices on the original text; untouched lines
 *   keep their exact terminators (spec §40).
 * - Within a replaced range, an exact line-level sequence diff preserves
 *   anchors for equal lines; changed/added lines receive new anchors;
 *   deleted anchors are retired (spec §6.1).
 * - New lines use the file's preferred line ending; the final line honors
 *   the `final_newline` policy when an operation reaches EOF (spec §41).
 * - No heuristic content correction ever happens (spec §24).
 */

import * as Diff from "diff";
import { AnchorAllocator } from "../anchors/allocator";
import { alignSequences, internIds } from "../anchors/sequence-map";
import {
  preferredEol,
  splitTextLines,
  joinTextLines,
  type Document,
  type LineEol,
  type TextLine,
} from "../document/lines";
import type { FinalNewline } from "./validate";

// ─── Overlap rules (spec §20) ──────────────────────────────────────────
// Destructive ranges that share any line are invalid — including ranges
// that merely share an endpoint line. Adjacent ranges are valid.
// Zero-width insertions at the same position are not overlaps; request
// order defines output order there (spec §23).

interface Span {
  requestIndex: number;
  byteStart: number;
  byteEnd: number; // exclusive
}

/** Returns the indexes of the first overlapping pair, if any. */
function findOverlap(sorted: Span[]): [number, number] | undefined {
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.byteStart < prev.byteEnd) {
      return [prev.requestIndex, cur.requestIndex];
    }
  }
  return undefined;
}

export interface EditOp {
  kind: "edit";
  /** 0-based inclusive line indexes in the original document. */
  start: number;
  end: number;
  lines: string[];
  requestIndex: number;
}

export interface InsertOp {
  kind: "insert";
  /** 0-based line index of the anchor line in the original document. */
  anchorIndex: number;
  direction: "before" | "after";
  lines: string[];
  requestIndex: number;
}

export type MutationOp = EditOp | InsertOp;

export interface DiffRow {
  prefix: " " | "+" | "-";
  anchor: string;
  text: string;
}

export interface EditMetrics {
  classification: "applied" | "noop";
  editsAttempted: number;
  editsApplied: number;
  editsNoop: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface ApplyResult {
  noop: boolean;
  document: Document;
  anchors: string[];
  retiredAdded: string[];
  diffRows: DiffRow[];
  metrics: EditMetrics;
  /** Set when `final_newline` was requested but no operation reached EOF. */
  unusedFinalNewline?: boolean;
}

interface PreparedSpan {
  requestIndex: number;
  opKind: "edit" | "insert";
  byteStart: number;
  byteEnd: number;
  insertBytes: string;
  /** Anchor bookkeeping for the result walk. */
  firstChangedOld: number;
  lastTouchedOld: number;
  newLines: string[];
  /**
   * Effective inserted line count. A final replacement line `""` with a
   * `""` eol (preserved "no final newline" state) contributes zero bytes —
   * it vanishes from the byte stream, so it must not receive an anchor.
   */
  effectiveNewLines: number;
  oldRangeTexts: string[];
  noopSub: boolean;
}

export function wouldEmptyMessage(): string {
  return `[E_WOULD_EMPTY] This edit would clear a non-empty file. Nothing was modified. Intentional whole-file clearing must use the explicit write tool.`;
}

function byteOffsets(lines: TextLine[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.text.length + line.eol.length;
  }
  return offsets;
}

function joinNewLines(
  lines: string[],
  prefEol: LineEol,
  finalEol: LineEol,
): string {
  if (lines.length === 0) return "";
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]!;
    out += i < lines.length - 1 ? prefEol : finalEol;
  }
  return out;
}

function prepareSpans(
  doc: Document,
  ops: MutationOp[],
  finalNewline: FinalNewline,
  originalText: string,
): { spans: PreparedSpan[]; unusedFinalNewline: boolean } {
  const lines = doc.lines;
  const offsets = byteOffsets(lines);
  const rawLen = originalText.length;
  const prefEol = preferredEol(lines);
  const n = lines.length;
  let reachesEof = false;

  const spans: PreparedSpan[] = [];
  for (const op of ops) {
    if (op.kind === "edit") {
      if (op.end === n - 1) reachesEof = true;
      const finalEol: LineEol =
        op.end === n - 1
          ? finalNewline === "present"
            ? prefEol
            : finalNewline === "absent"
              ? ""
              : lines[op.end]!.eol
          : prefEol;
      const byteStart = offsets[op.start]!;
      const byteEnd = op.end < n - 1 ? offsets[op.end + 1]! : rawLen;
      const oldRangeTexts = lines
        .slice(op.start, op.end + 1)
        .map((l) => l.text);
      const insertBytes = joinNewLines(op.lines, prefEol, finalEol);
      const vanishesLast =
        byteEnd === rawLen &&
        op.lines.length > 0 &&
        op.lines[op.lines.length - 1] === "" &&
        finalEol === "";
      spans.push({
        requestIndex: op.requestIndex,
        opKind: "edit",
        byteStart,
        byteEnd,
        insertBytes,
        firstChangedOld: op.start,
        lastTouchedOld: op.end,
        newLines: op.lines,
        effectiveNewLines: op.lines.length - (vanishesLast ? 1 : 0),
        oldRangeTexts,
        // Byte-exact no-op: the splice must reproduce the original bytes,
        // including the range's exact terminators (matters in files with
        // mixed line endings, where the recomputed final eol may differ).
        noopSub: insertBytes === originalText.slice(byteStart, byteEnd),
      });
    } else {
      const i = op.anchorIndex;
      if (op.direction === "after") {
        if (i === n - 1) reachesEof = true;
        const atEof = i === n - 1;
        const finalEol: LineEol = atEof
          ? finalNewline === "present"
            ? prefEol
            : finalNewline === "absent"
              ? ""
              : lines[i]!.eol
          : prefEol;
        const byteStart =
          offsets[i]! + lines[i]!.text.length + lines[i]!.eol.length;
        const prefix =
          atEof && lines[i]!.eol === "" && op.lines.length > 0 ? prefEol : "";
        const finalEolAtEof = finalEol;
        const vanishesLast =
          atEof &&
          op.lines.length > 0 &&
          op.lines[op.lines.length - 1] === "" &&
          finalEolAtEof === "";
        const insertBytes =
          prefix + joinNewLines(op.lines, prefEol, finalEolAtEof);
        spans.push({
          requestIndex: op.requestIndex,
          opKind: "insert",
          byteStart,
          byteEnd: byteStart,
          insertBytes,
          firstChangedOld: i + 1,
          lastTouchedOld: i,
          newLines: op.lines,
          effectiveNewLines: op.lines.length - (vanishesLast ? 1 : 0),
          oldRangeTexts: [],
          noopSub: insertBytes === "",
        });
      } else {
        const byteStart = offsets[i]!;
        spans.push({
          requestIndex: op.requestIndex,
          opKind: "insert",
          byteStart,
          byteEnd: byteStart,
          insertBytes: joinNewLines(op.lines, prefEol, prefEol),
          firstChangedOld: i,
          lastTouchedOld: i - 1,
          newLines: op.lines,
          effectiveNewLines: op.lines.length,
          oldRangeTexts: [],
          noopSub: op.lines.length === 0,
        });
      }
    }
  }
  return {
    spans,
    unusedFinalNewline: finalNewline !== "preserve" && !reachesEof,
  };
}

export function applyTransaction(
  doc: Document,
  anchorState: { anchors: string[]; retired: Set<string> },
  ops: MutationOp[],
  options: { finalNewline?: FinalNewline } = {},
): ApplyResult {
  const finalNewline = options.finalNewline ?? "preserve";
  const originalText = joinTextLines(doc.lines);
  const { spans, unusedFinalNewline } = prepareSpans(
    doc,
    ops,
    finalNewline,
    originalText,
  );
  const lines = doc.lines;

  if (spans.length > 0) {
    // Stable sort: byteStart asc, byteEnd asc, request index asc. Zero-width
    // insertions at the same position keep request order (spec §23).
    spans.sort((a, b) => {
      if (a.byteStart !== b.byteStart) return a.byteStart - b.byteStart;
      if (a.byteEnd !== b.byteEnd) return a.byteEnd - b.byteEnd;
      return a.requestIndex - b.requestIndex;
    });
    const sortedSpans: Span[] = spans.map((s) => ({
      requestIndex: s.requestIndex,
      byteStart: s.byteStart,
      byteEnd: s.byteEnd,
    }));
    const overlap = findOverlap(sortedSpans);
    if (overlap) {
      throw new Error(
        `[E_RANGE_OVERLAP] Requested edit #${overlap[0] + 1} overlaps edit #${overlap[1] + 1}. Ranges that share any line — even a single endpoint line — are invalid. Nothing was modified.`,
      );
    }
  }

  // ── Splice bytes ─────────────────────────────────────────────────────
  let resultText = "";
  let cursor = 0;
  for (const span of spans) {
    resultText += originalText.slice(cursor, span.byteStart);
    resultText += span.insertBytes;
    cursor = span.byteEnd;
  }
  resultText += originalText.slice(cursor);

  if (originalText.length > 0 && resultText.length === 0) {
    throw new Error(wouldEmptyMessage());
  }

  if (resultText === originalText) {
    const metrics: EditMetrics = {
      classification: "noop",
      editsAttempted: ops.length,
      editsApplied: 0,
      editsNoop: ops.length,
      linesAdded: 0,
      linesRemoved: 0,
    };
    return {
      noop: true,
      document: doc,
      anchors: anchorState.anchors.slice(),
      retiredAdded: [],
      diffRows: [],
      metrics,
      ...(unusedFinalNewline ? { unusedFinalNewline: true } : {}),
    };
  }

  const resultDoc: Document = {
    bom: doc.bom,
    lines: splitTextLines(resultText),
  };
  const resultLines = resultDoc.lines.map((l) => l.text);

  // ── Anchor walk ──────────────────────────────────────────────────────
  const oldTexts = lines.map((l) => l.text);
  const allocator = new AnchorAllocator(
    new Set(anchorState.anchors),
    anchorState.retired,
  );
  const newAnchors = new Array<string>(resultLines.length);
  const preservedOld = new Set<number>();
  let resultPos = 0;
  let prevOldEnd = -1;

  for (const span of spans) {
    for (let i = prevOldEnd + 1; i < span.firstChangedOld; i++) {
      newAnchors[resultPos] = anchorState.anchors[i]!;
      preservedOld.add(i);
      resultPos++;
    }
    if (span.opKind === "edit") {
      const oldRange = oldTexts.slice(
        span.firstChangedOld,
        span.lastTouchedOld + 1,
      );
      const mapping =
        oldRange.length > 3000 && span.newLines.length > 3000
          ? alignSequences(...internIds(oldRange, span.newLines))
          : alignSequences(oldRange, span.newLines);
      for (let j = 0; j < span.effectiveNewLines; j++) {
        const oldIdx = mapping.get(j);
        if (oldIdx !== undefined) {
          newAnchors[resultPos] =
            anchorState.anchors[span.firstChangedOld + oldIdx]!;
          preservedOld.add(span.firstChangedOld + oldIdx);
        } else {
          newAnchors[resultPos] = allocator.allocate(span.newLines[j]!);
        }
        resultPos++;
      }
      prevOldEnd = span.lastTouchedOld;
    } else {
      for (let j = 0; j < span.effectiveNewLines; j++) {
        newAnchors[resultPos] = allocator.allocate(span.newLines[j]!);
        resultPos++;
      }
      prevOldEnd = span.lastTouchedOld;
    }
  }
  for (let i = prevOldEnd + 1; i < oldTexts.length; i++) {
    newAnchors[resultPos] = anchorState.anchors[i]!;
    preservedOld.add(i);
    resultPos++;
  }

  const retiredAdded: string[] = [];
  for (let i = 0; i < anchorState.anchors.length; i++) {
    if (!preservedOld.has(i)) retiredAdded.push(anchorState.anchors[i]!);
  }
  const newRetired = new Set(anchorState.retired);
  for (const anchor of retiredAdded) newRetired.add(anchor);

  // ── Diff model (spec §26) ───────────────────────────────────────────
  const diffRows = buildDiffRows(
    oldTexts,
    anchorState.anchors,
    resultLines,
    newAnchors,
  );

  // ── Metrics ─────────────────────────────────────────────────────────
  let editsApplied = 0;
  let editsNoop = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const span of spans) {
    if (span.noopSub) {
      editsNoop++;
    } else {
      editsApplied++;
    }
    linesAdded += span.effectiveNewLines;
    if (span.opKind === "edit") {
      linesRemoved += span.lastTouchedOld - span.firstChangedOld + 1;
    }
  }

  const result: ApplyResult = {
    noop: false,
    document: resultDoc,
    anchors: newAnchors,
    retiredAdded,
    diffRows,
    metrics: {
      classification: "applied",
      editsAttempted: ops.length,
      editsApplied,
      editsNoop,
      linesAdded,
      linesRemoved,
    },
    ...(unusedFinalNewline ? { unusedFinalNewline: true } : {}),
  };
  return result;
}

/**
 * Anchored diff rows (spec §26): `" "` current unchanged rows (served),
 * `"+"` current new rows (served), `"-"` deleted historical rows (not
 * current editable lines). Rendered with bounded context like a unified
 * diff; the interleaving comes from the same deterministic alignment used
 * for anchor mapping, so removed and added rows never shuffle.
 */
export function buildDiffRows(
  oldTexts: string[],
  oldAnchors: string[],
  newTexts: string[],
  newAnchors: string[],
  contextLines = 2,
): DiffRow[] {
  // Trim identical prefix/suffix beyond context window to avoid O(N·D) on large
  // files with small edits. Keep at most `contextLines` of the identical edge
  // runs so the diff still has surrounding context.
  let prefix = 0;
  const maxPrefix = Math.min(oldTexts.length, newTexts.length);
  while (prefix < maxPrefix && oldTexts[prefix] === newTexts[prefix]) prefix++;
  let oldSuffix = oldTexts.length - 1;
  let newSuffix = newTexts.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldTexts[oldSuffix] === newTexts[newSuffix]
  ) {
    oldSuffix--;
    newSuffix--;
  }
  const suffixCount = oldTexts.length - 1 - oldSuffix;
  const oldStart = Math.max(0, prefix - contextLines);
  const newStart = Math.max(0, prefix - contextLines);
  const oldEnd = oldTexts.length - Math.max(0, suffixCount - contextLines);
  const newEnd = newTexts.length - Math.max(0, suffixCount - contextLines);
  const oldMid =
    oldStart === 0 && oldEnd === oldTexts.length
      ? oldTexts
      : oldTexts.slice(oldStart, oldEnd);
  const newMid =
    newStart === 0 && newEnd === newTexts.length
      ? newTexts
      : newTexts.slice(newStart, newEnd);
  const oldAnchorsMid =
    oldStart === 0 && oldEnd === oldAnchors.length
      ? oldAnchors
      : oldAnchors.slice(oldStart, oldEnd);
  const newAnchorsMid =
    newStart === 0 && newEnd === newAnchors.length
      ? newAnchors
      : newAnchors.slice(newStart, newEnd);

  if (oldMid.length === 0 && newMid.length === 0) return [];

  // Use dense integer IDs for large mids to avoid O(64) string comparisons.
  const parts =
    oldMid.length > 3000 && newMid.length > 3000
      ? Diff.diffArrays(...internIds(oldMid, newMid))
      : Diff.diffArrays(oldMid as string[], newMid as string[]);

  const rows: DiffRow[] = [];
  let oldPos = 0;
  let newPos = 0;
  let lastWasChange = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const count = part.value.length;
    if (part.added || part.removed) {
      if (part.added) {
        for (let k = 0; k < count; k++) {
          rows.push({
            prefix: "+",
            anchor: newAnchorsMid[newPos]!,
            text: newMid[newPos]!,
          });
          newPos++;
        }
      } else {
        for (let k = 0; k < count; k++) {
          rows.push({
            prefix: "-",
            anchor: oldAnchorsMid[oldPos]!,
            text: oldMid[oldPos]!,
          });
          oldPos++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextIsChange =
      i + 1 < parts.length && (parts[i + 1]!.added || parts[i + 1]!.removed);
    if (lastWasChange || nextIsChange) {
      let start = 0;
      let end = count;
      let skipStart = 0;
      let middleSkipped = 0;
      let tailCount = 0;
      let tailSkipped = 0;
      if (!lastWasChange) {
        skipStart = Math.max(0, count - contextLines);
        start = skipStart;
      } else if (nextIsChange && count > contextLines * 2) {
        end = contextLines;
        middleSkipped = count - contextLines * 2;
        tailCount = contextLines;
      } else if (!nextIsChange && count > contextLines) {
        end = contextLines;
        tailSkipped = count - contextLines;
      }
      if (skipStart > 0) {
        rows.push({ prefix: " ", anchor: "", text: "..." });
        newPos += skipStart;
        oldPos += skipStart;
      }
      for (let k = start; k < end; k++) {
        rows.push({
          prefix: " ",
          anchor: newAnchorsMid[newPos]!,
          text: newMid[newPos]!,
        });
        newPos++;
        oldPos++;
      }
      if (middleSkipped > 0) {
        rows.push({ prefix: " ", anchor: "", text: "..." });
        newPos += middleSkipped;
        oldPos += middleSkipped;
        for (let k = 0; k < tailCount; k++) {
          rows.push({
            prefix: " ",
            anchor: newAnchorsMid[newPos]!,
            text: newMid[newPos]!,
          });
          newPos++;
          oldPos++;
        }
      }
      if (tailSkipped > 0) {
        rows.push({ prefix: " ", anchor: "", text: "..." });
        newPos += tailSkipped;
        oldPos += tailSkipped;
      }
    } else {
      newPos += count;
      oldPos += count;
    }
    lastWasChange = false;
  }
  // Restore ellipsis for the trimmed-away outer runs beyond the context window.
  // The mid diff only saw the last `contextLines` of the prefix and first
  // `contextLines` of the suffix; the omitted `oldStart` prefix lines and
  // `oldTexts.length - oldEnd` suffix lines must still be indicated.
  if (rows.length > 0) {
    if (oldStart > 0 && rows[0]!.text !== "...") {
      rows.unshift({ prefix: " ", anchor: "", text: "..." });
    }
    if (oldEnd < oldTexts.length && rows[rows.length - 1]!.text !== "...") {
      rows.push({ prefix: " ", anchor: "", text: "..." });
    }
  }
  return rows;
}
