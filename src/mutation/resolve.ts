/**
 * Anchor resolution (spec §10, §54, §31.10).
 *
 * References are resolved against the current document by anchor identity,
 * never by line number and never by fuzzy matching. A reference that is no
 * longer current fails with E_ANCHOR_STALE; reversed ranges fail with
 * E_RANGE_REVERSED and are never swapped automatically (spec §16).
 */

import { MAX_FEEDBACK_LINES, READ_MAX_OUTPUT_BYTES } from "../constants";
import { renderLinesBounded } from "../render/engine";
import { serveLines } from "../served/ledger";

/**
 * E_ANCHOR_STALE feedback: serve a bounded fresh anchored view so the
 * retry has current authorization, and return the formatted error message.
 * Rows are rendered through the same path as read — complete text, with
 * oversized lines omitted and unserved — so a row is served only when the
 * model actually received its full contents.
 */
export function staleAnchorMessage(
  path: string,
  anchor: string,
  anchors: readonly string[],
  texts: readonly string[],
  around?: number,
): string {
  const total = texts.length;
  let start: number;
  if (around !== undefined) {
    start = Math.max(0, Math.min(around - 2, total - 1));
  } else {
    start = 0;
  }
  const shown = Math.min(MAX_FEEDBACK_LINES, total - start);
  const bounded = renderLinesBounded(
    anchors,
    texts,
    start,
    start + shown,
    READ_MAX_OUTPUT_BYTES,
  );
  serveLines(path, bounded.served);
  let text = bounded.text;
  if (bounded.truncated) {
    text += `\n\n[Feedback truncated at the ${READ_MAX_OUTPUT_BYTES / 1024}KB budget. Use read with offset=${bounded.nextLine + 1} to continue.]`;
  }
  const location = ` in ${path}`;
  const hint =
    around !== undefined ? "" : "\n\nUse read() to get fresh anchors.";
  return `[E_ANCHOR_STALE] Anchor "${anchor}" is no longer current${location}: the file content changed since that anchor was read. Nothing was modified.${hint}\n\nCurrent context with fresh anchors:\n${text}`;
}

/**
 * Unknown-anchor feedback (amends spec §10). An anchor that is neither
 * active nor retired was never allocated for this file — it was constructed,
 * not copied from tool output. Reporting it as stale implies a phantom
 * on-disk change (the file may be completely untouched), which sends the
 * caller into retry loops. Report the real cause, and offer a
 * case-insensitive near-match when exactly one exists (transcription slips
 * like FQhk→Fqhk).
 */
export function unknownAnchorMessage(
  path: string,
  anchor: string,
  anchors: readonly string[],
): string {
  const folded = anchor.toLowerCase();
  const near = anchors.filter((a) => a.toLowerCase() === folded);
  const suggestion = near.length === 1 ? ` Did you mean "${near[0]}"?` : "";
  return (
    `[E_ANCHOR_NOT_SERVED] Anchor "${anchor}" is not a valid anchor in ${path}: it was never allocated for this file, so it was never shown to you. ` +
    `Do not construct or transcribe anchors — copy them verbatim from read/grep/diff output.${suggestion} Nothing was modified.\n\n` +
    `Use read() (or grep) to view the target region and copy the real anchors.`
  );
}

export function reversedRangeMessage(
  path: string,
  startAnchor: string,
  endAnchor: string,
): string {
  return `[E_RANGE_REVERSED] Range start occurs after range end${path ? ` in ${path}` : ""} (start anchor "${startAnchor}" is after end anchor "${endAnchor}"). Nothing was modified. The anchors were not swapped; send the range in document order.`;
}
