/**
 * Bounded rendering engine (spec §12, §25, §26, PH-OUTPUT-001..007).
 *
 * Consolidates the single bounded-output engine that was split across
 * budget.ts + diff.ts + hashline.ts:
 * - CandidateRow → applyOutputBudget → renderLinesBounded / renderDiff
 * - per-line display limit, total byte budget, truncation only between rows,
 *   served only for retained complete rows.
 *
 * Exposes: renderLinesBounded, renderDiff, and renderLinesUnserved,
 * plus shared types and formatters. applyOutputBudget remains internal.
 */

import { HASH_SEP } from "../anchors/alphabet";
import {
  DIFF_MAX_OUTPUT_BYTES,
  MAX_DISPLAY_LINE_BYTES,
  READ_MAX_OUTPUT_BYTES,
} from "../constants";
import { formatSize } from "../utils";
import type { DiffRow } from "../mutation/apply";

// --- Budget core (from budget.ts) ---

export interface CandidateRow {
  /** The exact rendered row text for output. */
  rendered: string;
  /** Precomputed byte length of rendered (without trailing delimiter). */
  renderedBytes?: number;
  /**
   * Present only when the row is a complete exact file row that may enter
   * the served ledger once retained. Omission notices and structural rows
   * carry no servable entry.
   */
  servable?: {
    anchor: string;
    exactText: string;
    lineIndex?: number;
    path?: string;
  };
}

export interface BudgetedOutput {
  /** Retained rendered rows, in order. */
  rows: string[];
  /** Complete exact rows retained — the only rows that may be served. */
  served: Array<{
    anchor: string;
    exactText: string;
    lineIndex?: number;
    path?: string;
  }>;
  /** True when at least one candidate row was dropped by the byte budget. */
  truncated: boolean;
  /** Number of candidate rows dropped by the byte budget. */
  dropped: number;
}

/**
 * Retain candidate rows while they fit the total byte budget. Truncation
 * happens only between complete rows (PH-OUTPUT-004): the first row that
 * does not fit ends the output, and every later row is dropped with it —
 * rows are never sliced and never reordered.
 */
export function applyOutputBudget(
  candidates: readonly CandidateRow[],
  maxTotalBytes: number,
): BudgetedOutput {
  const rows: string[] = [];
  const served: BudgetedOutput["served"] = [];
  let budget = maxTotalBytes;
  let dropped = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const bytes =
      (candidate.renderedBytes ??
        Buffer.byteLength(candidate.rendered, "utf-8")) + 1;
    if (bytes > budget) {
      dropped = candidates.length - i;
      break;
    }
    budget -= bytes;
    rows.push(candidate.rendered);
    if (candidate.servable) served.push(candidate.servable);
  }
  return { rows, served, truncated: dropped > 0, dropped };
}

// --- Diff rendering (from diff.ts) ---

export interface RenderedDiff {
  text: string;
  /** Complete exact current rows retained in the output. */
  served: Array<{ anchor: string; exactText: string; lineIndex?: number }>;
  servedRows: number;
  truncated: boolean;
}

export function formatDiffRow(row: DiffRow): string {
  if (row.anchor === "") {
    return `${row.prefix} ${HASH_SEP}${row.text}`;
  }
  return `${row.prefix}${row.anchor}${HASH_SEP}${row.text}`;
}

function omittedCurrentRow(bytes: number): string {
  return `[current diff row omitted: ${formatSize(bytes)}. The row is too large to display and is not authorized for further edits; inspect it with a targeted workflow.]`;
}

function omittedRemovedRow(bytes: number): string {
  return `[removed diff row omitted: ${formatSize(bytes)}]`;
}

export function renderDiff(rows: DiffRow[]): RenderedDiff {
  const candidates: CandidateRow[] = [];
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.text, "utf-8");
    if (row.prefix === "-") {
      // Historical rows are never served; oversized ones are summarized.
      if (bytes > MAX_DISPLAY_LINE_BYTES) {
        candidates.push({ rendered: omittedRemovedRow(bytes) });
      } else {
        const rendered = formatDiffRow(row);
        candidates.push({
          rendered,
          renderedBytes: bytes + (row.anchor ? 8 : 5),
        });
      }
      continue;
    }
    if (row.anchor === "") {
      // Structural rows (ellipsis markers) carry no content.
      candidates.push({ rendered: formatDiffRow(row) });
      continue;
    }
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      // PH-OUTPUT-007: an omitted current row must not become servable.
      candidates.push({ rendered: omittedCurrentRow(bytes) });
      continue;
    }
    const rendered = formatDiffRow(row);
    candidates.push({
      rendered,
      renderedBytes: bytes + 8,
      servable: { anchor: row.anchor, exactText: row.text },
    });
  }
  const budgeted = applyOutputBudget(candidates, DIFF_MAX_OUTPUT_BYTES);
  const output = budgeted.truncated
    ? [
        ...budgeted.rows,
        `[diff output truncated: ${budgeted.dropped} more row(s) were omitted to stay within the ${formatSize(DIFF_MAX_OUTPUT_BYTES)} output budget. Omitted rows are not authorized for edits; use read to view them.]`,
      ]
    : budgeted.rows;
  const text = output.join("\n");
  return {
    text,
    served: budgeted.served,
    servedRows: budgeted.served.length,
    truncated: budgeted.truncated,
  };
}

// --- Hashline rendering (from hashline.ts) ---

export function formatDisplayRow(anchor: string, text: string): string {
  return `${anchor}${HASH_SEP}${text}`;
}

export function omittedRow(lineNumber: number, bytes: number): string {
  return `[Line ${lineNumber} omitted: ${formatSize(bytes)}. [E_LINE_TOO_LARGE] Not authorized for edits; use read with an appropriate inspection workflow.]`;
}

/**
 * Render document lines 0-based [start, end) WITHOUT serving them. Use when
 * the rendered rows may still be truncated or dropped downstream; serve the
 * surviving rows explicitly via serveLines so the ledger only ever contains
 * complete rows the model actually received.
 */
export function renderLinesUnserved(
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): { rows: string[]; served: Array<{ anchor: string; exactText: string }> } {
  const rows: string[] = [];
  const served: Array<{ anchor: string; exactText: string }> = [];
  for (let line = startLine; line < endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      rows.push(omittedRow(line + 1, bytes));
      continue;
    }
    rows.push(formatDisplayRow(anchor, text));
    served.push({ anchor, exactText: text });
  }
  return { rows, served };
}

export interface BoundedRender {
  /** Rendered text of retained rows. */
  text: string;
  /** Complete exact rows retained — the only rows served. */
  served: Array<{ anchor: string; exactText: string; lineIndex?: number }>;
  /** 0-based index of the first line NOT rendered (== endLine when none dropped). */
  nextLine: number;
  /** True when the byte budget dropped at least one row. */
  truncated: boolean;
}

/**
 * Render document lines 0-based [start, end) under the total read output
 * budget (PH-OUTPUT-003). Oversized lines become omission notices; the byte
 * budget truncates between complete rows. Only retained complete rows are
 * served (PH-OUTPUT-002/005). Returns continuation info (PH-OUTPUT-006).
 */
export function renderLinesBounded(
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
  maxTotalBytes: number = READ_MAX_OUTPUT_BYTES,
): BoundedRender {
  const candidates: CandidateRow[] = [];
  for (let line = startLine; line < endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const bytes = Buffer.byteLength(text, "utf-8");
    if (bytes > MAX_DISPLAY_LINE_BYTES) {
      candidates.push({ rendered: omittedRow(line + 1, bytes) });
      continue;
    }
    candidates.push({
      rendered: formatDisplayRow(anchor, text),
      renderedBytes: bytes + 7,
      servable: { anchor, exactText: text, lineIndex: line },
    });
  }
  const budgeted = applyOutputBudget(candidates, maxTotalBytes);
  // Candidates are 1:1 with source lines, and truncation keeps a prefix, so
  // continuation resumes right after the last retained row (PH-OUTPUT-006).
  const nextLine = budgeted.truncated
    ? startLine + budgeted.rows.length
    : endLine;
  return {
    text: budgeted.rows.join("\n"),
    served: budgeted.served.map(({ anchor, exactText, lineIndex }) => ({
      anchor,
      exactText,
      ...(lineIndex !== undefined ? { lineIndex } : {}),
    })),
    nextLine,
    truncated: budgeted.truncated,
  };
}
