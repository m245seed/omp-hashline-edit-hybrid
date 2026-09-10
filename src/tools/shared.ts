/**
 * Shared mutation-tool types and helpers: MutationMetrics,
 * resolveMutationTarget, buildMutationMetrics, and the common
 * commit-and-render pipeline used by edit/insert (undo reuses only the
 * diff-row rendering part).
 */
import { toCwd } from "../paths";
import { resolveTarget } from "../filesystem/resolve-target";
import {
  commitMutation,
  encodeAfterBytes,
  anchorSpaceWarning,
  mixedEndingsWarning,
  type AnchoredFile,
} from "../mutation/transaction";
import type { ApplyResult, DiffRow } from "../mutation/apply";
import { renderDiff, renderLinesBounded } from "../render/engine";
import { serveLines, servedWindowNotice } from "../served/ledger";
import { fingerprintHexes } from "../anchors/fingerprints";
import { hashlineDetails, type HashlineResultDetails } from "../render/result-details";
import { newTransactionId } from "../state/transaction-journal";
import { abortIf, sha256Hex, debugLog } from "../utils";
import { AUTO_READ_MAX_LINES, AUTO_READ_MAX_BYTES } from "../constants";

export interface MutationMetrics {
  classification: "applied" | "noop";
  edits_attempted: number;
  edits_applied: number;
  edits_noop: number;
  lines_added: number;
  lines_removed: number;
  warnings: number;
  before_revision: string;
  after_revision: string;
  transaction_id: string | null;
}

export async function resolveMutationTarget(path: string, cwd: string): Promise<string> {
  const absolutePath = toCwd(path, cwd);
  return resolveTarget(absolutePath);
}

export function buildMutationMetrics(input: {
  classification: "applied" | "noop";
  editsAttempted: number;
  editsApplied: number;
  editsNoop: number;
  linesAdded: number;
  linesRemoved: number;
  warnings: number;
  beforeRevision: string;
  afterRevision: string;
  transactionId: string | null;
}): MutationMetrics {
  return {
    classification: input.classification,
    edits_attempted: input.editsAttempted,
    edits_applied: input.editsApplied,
    edits_noop: input.editsNoop,
    lines_added: input.linesAdded,
    lines_removed: input.linesRemoved,
    warnings: input.warnings,
    before_revision: input.beforeRevision,
    after_revision: input.afterRevision,
    transaction_id: input.transactionId,
  };
}

export interface MutationOutcome {
  content: Array<{ type: "text"; text: string }>;
  details: { diff?: string; metrics: MutationMetrics; hashline: HashlineResultDetails };
}

/** Renders diff rows and serves their exact content; appends the served
 *  window notice when ledger evictions occurred. */
export function renderAndServeDiffRows(
  diffRows: DiffRow[],
  realPath: string,
): { text: string; servedRows: number } {
  const diff = renderDiff(diffRows);
  const evictedRows = serveLines(realPath, diff.served);
  let text = diff.text;
  if (evictedRows > 0) text += servedWindowNotice(evictedRows);
  return { text, servedRows: diff.servedRows };
}

/** Runs the shared post-applyTransaction pipeline: warnings, noop
 *  short-circuit, optional preflight, atomic commit, render-and-serve diff. */
export async function commitAndRenderMutation(opts: {
  tool: "edit" | "insert";
  /** request.path, used in error/warning text. */
  displayPath: string;
  /** Resolved mutation target. */
  realPath: string;
  /** From loadAnchoredFile. */
  file: AnchoredFile;
  /** From applyTransaction. */
  result: ApplyResult;
  expectedRevision?: string;
  signal?: AbortSignal;
  /** Runs after the noop check, before commit. Throw to reject the whole
   *  transaction; call addWarning to append a warning carried into commit. */
  preflight?: (addWarning: (warning: string) => void) => void;
}): Promise<MutationOutcome> {
  const { file, result } = opts;
  const warnings: string[] = [];
  if (result.unusedFinalNewline) {
    warnings.push(
      `[W_UNUSED_OPTION] "final_newline" was specified but no ${opts.tool} reaches the end of the file; it was not applied.`,
    );
  }
  const retiredAfter = new Set([...file.retired, ...result.retiredAdded]);
  const pressure = anchorSpaceWarning(new Set(result.anchors).size, retiredAfter.size);
  if (pressure) warnings.push(pressure);
  const mixed = mixedEndingsWarning(file.doc, result.metrics.linesAdded);
  if (mixed) warnings.push(mixed);

  const beforeRevision = file.checksum;

  if (result.noop) {
    const metrics = buildMutationMetrics({
      classification: "noop",
      editsAttempted: result.metrics.editsAttempted,
      editsApplied: 0,
      editsNoop: result.metrics.editsNoop,
      linesAdded: 0,
      linesRemoved: 0,
      warnings: warnings.length,
      beforeRevision,
      afterRevision: beforeRevision,
      transactionId: null,
    });
    return {
      content: [{ type: "text", text: "No changes made." }],
      details: {
        metrics,
        hashline: hashlineDetails({
          outcome: "no_change",
          code: "NO_CHANGE",
          fileSha256: beforeRevision,
          servedRows: 0,
        }),
      },
    };
  }

  const afterRaw = encodeAfterBytes(result.document);
  const afterChecksum = sha256Hex(afterRaw);
  const transactionId = newTransactionId();

  opts.preflight?.((w) => warnings.push(w));
  abortIf(opts.signal);
  await commitMutation({
    realPath: opts.realPath,
    label: opts.displayPath,
    rawBefore: file.raw,
    checksumBefore: beforeRevision,
    docBefore: file.doc,
    anchorsBefore: file.anchors,
    fingerprintsBefore: file.fingerprints,
    retiredBefore: file.retired,
    rawAfter: afterRaw,
    checksumAfter: afterChecksum,
    docAfter: result.document,
    anchorsAfter: result.anchors,
    fingerprintsAfter: fingerprintHexes(result.document.lines.map((line) => line.text)),
    retiredAfter,
    transactionId,
    signal: opts.signal,
    expectedRevision: opts.expectedRevision,
    keepUndo: true,
    warnings,
  });

  const { text: diffText, servedRows } = renderAndServeDiffRows(result.diffRows, opts.realPath);
  const metrics = buildMutationMetrics({
    classification: result.metrics.classification,
    editsAttempted: result.metrics.editsAttempted,
    editsApplied: result.metrics.editsApplied,
    editsNoop: result.metrics.editsNoop,
    linesAdded: result.metrics.linesAdded,
    linesRemoved: result.metrics.linesRemoved,
    warnings: warnings.length,
    beforeRevision,
    afterRevision: afterChecksum,
    transactionId,
  });
  const text = warnings.length > 0 ? `${diffText}\n\n${warnings.join("\n")}` : diffText;
  debugLog(`${opts.tool} committed`, { path: opts.realPath, metrics, warnings });

  return {
    content: [{ type: "text", text }],
    details: {
      diff: diffText,
      metrics,
      hashline: hashlineDetails({
        outcome: "success",
        code: "OK",
        transactionId,
        fileSha256: afterChecksum,
        servedRows,
        warnings,
      }),
    },
  };
}

/** Bounded anchored preview (PH-WRITE-002): first AUTO_READ_MAX_LINES rows
 *  under AUTO_READ_MAX_BYTES; retained complete rows become served. */
export function renderAutoReadPreview(
  anchors: string[],
  texts: string[],
  realPath: string,
): { text: string; servedRows: number } {
  const previewEnd = Math.min(texts.length, AUTO_READ_MAX_LINES);
  const preview = renderLinesBounded(anchors, texts, 0, previewEnd, AUTO_READ_MAX_BYTES);
  const evictedRows = serveLines(realPath, preview.served);
  let text = preview.text;
  if (preview.truncated) {
    text += `\n\n[Preview truncated at the ${AUTO_READ_MAX_BYTES / 1024}KB budget. Use read to see more.]`;
  } else if (previewEnd < texts.length) {
    text += `\n\n[Showing the first ${previewEnd} lines of ${texts.length}. Use read to see more.]`;
  }
  if (evictedRows > 0) {
    text += servedWindowNotice(evictedRows);
  }
  return { text, servedRows: preview.served.length };
}
