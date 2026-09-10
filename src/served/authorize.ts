/**
 * Range authorization (spec §10, §60 invariants A & B, PH-CONTEXT-001..004,
 * PH-OUTPUT-008).
 *
 * To destructively modify a range, every current line in the range must have
 * been fully served during this session AND must still contain exactly the
 * content the model saw. Served authorizations also belong to a context
 * epoch (PH-CONTEXT-001): after compaction/tree/session transition the model
 * can no longer be assumed to hold the exact content, so rows from older
 * epochs do not authorize destructive edits (PH-CONTEXT-003) and are
 * rejected with E_CONTEXT_EPOCH_STALE (PH-CONTEXT-004).
 *
 * The failures are reported distinctly:
 *
 * - E_ANCHOR_NOT_SERVED: at least one line was never shown.
 * - E_RANGE_STALE: a previously shown line no longer matches.
 * - E_CONTEXT_EPOCH_STALE: a matching line was served in an older epoch.
 *
 * All reject the whole transaction; the response includes a bounded fresh
 * anchored view of the affected range, and those rows become served so
 * retries are efficient. Feedback rendering never bypasses oversized-line
 * protections (PH-OUTPUT-008).
 */

import { MAX_FEEDBACK_LINES, READ_MAX_OUTPUT_BYTES } from "../constants";
import { renderLinesBounded } from "../render/engine";
import { getLedger, getStaleSet, serveLines } from "./ledger";
import { getContextEpoch } from "./epoch";

export interface RangeCheck {
  ok: boolean;
  code:
    "E_ANCHOR_NOT_SERVED" | "E_RANGE_STALE" | "E_CONTEXT_EPOCH_STALE" | null;
  /** 0-based line indexes that failed, first group (unserved, then stale). */
  unserved: number[];
  stale: number[];
  /** 0-based line indexes served in an older context epoch. */
  epochStale: number[];
}

export function checkRangeServed(
  path: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): RangeCheck {
  const unserved: number[] = [];
  const stale: number[] = [];
  const epochStale: number[] = [];
  const epoch = getContextEpoch();
  // Hoist per-file lookups outside loop (was O(N) map lookups per line via servedEntry/isStale)
  const fileLedger = getLedger().get(path);
  const staleSet = getStaleSet(path);
  for (let line = startLine; line <= endLine; line++) {
    const anchor = anchors[line]!;
    const text = texts[line]!;
    const entry = fileLedger?.get(anchor);
    if (entry === undefined) {
      // A line that was shown and then changed externally is stale, not
      // merely unseen (spec §71).
      if (staleSet?.has(anchor)) {
        stale.push(line);
      } else {
        unserved.push(line);
      }
    } else if (entry.exactText !== text) {
      stale.push(line);
    } else if (entry.epoch < epoch) {
      // PH-CONTEXT-003: matching content from an older epoch no longer
      // authorizes a destructive edit.
      epochStale.push(line);
    }
  }
  if (unserved.length === 0 && stale.length === 0 && epochStale.length === 0) {
    return { ok: true, code: null, unserved, stale, epochStale };
  }
  const code =
    stale.length > 0
      ? "E_RANGE_STALE"
      : epochStale.length > 0
        ? "E_CONTEXT_EPOCH_STALE"
        : "E_ANCHOR_NOT_SERVED";
  return { ok: false, code, unserved, stale, epochStale };
}

/**
 * Build the bounded fresh anchored view for a failed range and serve the
 * rows (spec §10: "Those returned lines then become served"). Oversized
 * lines are omitted with a notice and NOT served (PH-OUTPUT-008).
 */
export function feedbackRange(
  path: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
): string {
  const total = endLine - startLine + 1;
  const shown = Math.min(total, MAX_FEEDBACK_LINES);
  const bounded = renderLinesBounded(
    anchors,
    texts,
    startLine,
    startLine + shown,
    READ_MAX_OUTPUT_BYTES,
  );
  serveLines(path, bounded.served);
  const capHint = bounded.truncated
    ? `\n\n[The range output was truncated at the ${READ_MAX_OUTPUT_BYTES / 1024}KB budget. Use read with offset=${bounded.nextLine + 1} to continue.]`
    : total > shown
      ? `\n\n[The range has ${total} lines; showing the first ${shown}. Use read with offset=${startLine + shown + 1} to see the rest.]`
      : "";
  return `${bounded.text}${capHint}`;
}

export function formatRangeFailure(
  displayPath: string,
  ledgerPath: string,
  anchors: readonly string[],
  texts: readonly string[],
  startLine: number,
  endLine: number,
  check: RangeCheck,
): string {
  const total = endLine - startLine + 1;
  const location = ` in ${displayPath}`;
  if (check.code === "E_CONTEXT_EPOCH_STALE") {
    const count = check.epochStale.length;
    const detail =
      count === 1
        ? `Line ${check.epochStale[0]! + 1} of the requested range (lines ${startLine + 1}-${endLine + 1})${location} was shown before the context was rebuilt; its authorization has expired.`
        : `${count} of ${total} line(s) inside the requested destructive range (lines ${startLine + 1}-${endLine + 1})${location} were shown before the context was rebuilt; their authorization has expired.`;
    return (
      `[E_CONTEXT_EPOCH_STALE] ${detail} Nothing was modified. ` +
      `Re-read the range to re-authorize it in the current context epoch.\n\nCurrent range with fresh anchors:\n${feedbackRange(ledgerPath, anchors, texts, startLine, endLine)}`
    );
  }
  if (check.code === "E_ANCHOR_NOT_SERVED") {
    const count = check.unserved.length;
    const first = check.unserved[0]!;
    const detail =
      count === 1
        ? `Line ${first + 1} of the requested range (lines ${startLine + 1}-${endLine + 1})${location} was not shown in this session.`
        : `${count} of ${total} line(s) inside the requested destructive range (lines ${startLine + 1}-${endLine + 1})${location} were not shown in this session.`;
    return `[E_ANCHOR_NOT_SERVED] ${detail} Nothing was modified.\n\nCurrent range with fresh anchors:\n${feedbackRange(ledgerPath, anchors, texts, startLine, endLine)}`;
  }
  const count = check.stale.length;
  const first = check.stale[0]!;
  const detail =
    count === 1
      ? `Line ${first + 1} of the requested range (lines ${startLine + 1}-${endLine + 1})${location} differs from what was shown.`
      : `${count} of ${total} line(s) in the requested range (lines ${startLine + 1}-${endLine + 1})${location} differ from what was shown.`;
  return `[E_RANGE_STALE] ${detail} The file changed on disk after the anchors were read. Nothing was modified.\n\nCurrent range with fresh anchors:\n${feedbackRange(ledgerPath, anchors, texts, startLine, endLine)}`;
}
