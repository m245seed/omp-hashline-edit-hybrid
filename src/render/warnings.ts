/**
 * Edit safety preflights (spec §31.2, §31.3).
 *
 * Both checks run BEFORE commit (PH-EDIT-001, PH-EDIT-006): a detected
 * condition rejects the whole transaction with a stable code and bounded
 * evidence; nothing is modified. Semantic heuristics only increase caution —
 * they never authorize an edit (spec §31.3).
 *
 * Boundary duplication (PH-EDIT-005): multi-line detection compares complete
 * slices in document order. For candidate size k:
 *
 *   leading:  replacement.slice(0, k) === fileLines.slice(startIndex - k, startIndex)
 *   trailing: replacement.slice(replacement.length - k) === fileLines.slice(endIndex + 1, endIndex + 1 + k)
 *
 * The largest matching k is searched first. The neighbor lines are the lines
 * that will be adjacent AFTER the whole transaction applies, so an edit whose
 * adjacent line is itself changed by another edit in the same call is not
 * flagged.
 */

export interface BoundaryDupFinding {
  kind: "leading" | "trailing";
  /** Number of duplicated lines (the largest matching k). */
  size: number;
  /** The duplicated lines, in document order. */
  lines: string[];
}

/**
 * Detect boundary duplication for one replacement against its post-
 * transaction neighbor lines. `beforeLines` are the lines immediately
 * preceding the range after all other edits apply (document order, nearest
 * last); `afterLines` are the lines immediately following the range (nearest
 * first).
 */
export function detectBoundaryDuplication(
  replacement: readonly string[],
  beforeLines: readonly string[],
  afterLines: readonly string[],
): BoundaryDupFinding[] {
  const findings: BoundaryDupFinding[] = [];
  if (replacement.length === 0) return findings;

  // Trailing: largest k first (PH-EDIT-005). Compare without allocating slices.
  const maxTrailing = Math.min(replacement.length, afterLines.length);
  for (let k = maxTrailing; k >= 1; k--) {
    let equal = true;
    const repStart = replacement.length - k;
    for (let i = 0; i < k; i++) {
      if (replacement[repStart + i] !== afterLines[i]) {
        equal = false;
        break;
      }
    }
    if (equal) {
      findings.push({
        kind: "trailing",
        size: k,
        lines: afterLines.slice(0, k),
      });
      break;
    }
  }

  // Leading: largest k first.
  const maxLeading = Math.min(replacement.length, beforeLines.length);
  for (let k = maxLeading; k >= 1; k--) {
    let equal = true;
    const beforeStart = beforeLines.length - k;
    for (let i = 0; i < k; i++) {
      if (replacement[i] !== beforeLines[beforeStart + i]) {
        equal = false;
        break;
      }
    }
    if (equal) {
      findings.push({
        kind: "leading",
        size: k,
        lines: beforeLines.slice(beforeLines.length - k),
      });
      break;
    }
  }

  return findings;
}

/** Bounded evidence lines for a rejection message (PH-EDIT-004). */
export function boundaryDupEvidence(finding: BoundaryDupFinding): string {
  const shown = finding.lines.slice(0, 3);
  const more = finding.lines.length - shown.length;
  const quoted = shown.map((line) => JSON.stringify(line)).join(", ");
  return more > 0 ? `${quoted}, … (${more} more)` : quoted;
}

export function boundaryDupRejection(
  path: string,
  editIndex: number,
  findings: BoundaryDupFinding[],
): string {
  const parts = findings.map((finding) => {
    const side =
      finding.kind === "trailing"
        ? `ends with ${finding.size} line(s) identical to the unchanged block immediately after the range`
        : `starts with ${finding.size} line(s) identical to the unchanged block immediately before the range`;
    return `edit #${editIndex + 1} ${side}: ${boundaryDupEvidence(finding)}`;
  });
  return (
    `[E_BOUNDARY_DUP] In ${path}: ${parts.join("; ")}. ` +
    `This usually means the range or replacement is off by those lines. Nothing was modified. ` +
    `Re-check the range boundaries; if the duplication is intentional, resend with "allow_boundary_duplicate": true.`
  );
}

/**
 * Informational warning used when the explicit escape hatch
 * (`allow_boundary_duplicate: true`) suppresses the rejection: the request
 * was applied literally; verify the diff (spec §55).
 */
export function boundaryDupWarning(
  path: string,
  editIndex: number,
  findings: BoundaryDupFinding[],
): string {
  const parts = findings.map((finding) => {
    const side =
      finding.kind === "trailing"
        ? `ends with ${finding.size} line(s) identical to the block after the range`
        : `starts with ${finding.size} line(s) identical to the block before the range`;
    return `edit #${editIndex + 1} ${side}`;
  });
  return `[W_BOUNDARY_DUP] In ${path}: ${parts.join("; ")}. The request was applied literally with "allow_boundary_duplicate": true; verify the diff.`;
}

/**
 * Compute the post-transaction line texts and, for each operation, the index
 * where its replacement begins in that post-transaction sequence. Operations
 * MUST be sorted by `start` and non-overlapping (validated by the mutation
 * engine before this is called). Used to compare a replacement against the
 * lines that will be adjacent AFTER the whole call applies (PH-EDIT-005), so
 * an edit whose neighbor is itself changed by another edit is not flagged.
 */
export function computePostTransactionTexts(
  fileTexts: readonly string[],
  sortedOps: ReadonlyArray<{ start: number; end: number; lines: readonly string[] }>,
): { texts: string[]; insertPositions: number[] } {
  const texts: string[] = [];
  const insertPositions: number[] = [];
  let cursor = 0;
  for (const op of sortedOps) {
    for (let i = cursor; i < op.start; i++) texts.push(fileTexts[i]!);
    insertPositions.push(texts.length);
    for (const line of op.lines) texts.push(line);
    cursor = op.end + 1;
  }
  for (let i = cursor; i < fileTexts.length; i++) texts.push(fileTexts[i]!);
  return { texts, insertPositions };
}

/**
 * Large destructive edit guard (PH-EDIT-006..008). Heuristic:
 *
 *   removedLines >= minRemovedLines AND removedLines > removedRatio * max(1, addedLines)
 *
 * Thresholds come from the configurable large-edit guard (see
 * getLargeEditGuard/setLargeEditGuard in constants.ts). This heuristic
 * only increases caution; it never authorizes an edit.
 */
export function isLargeDestructiveChange(
  removedLines: number,
  addedLines: number,
  guard: { minRemovedLines: number; removedRatio: number },
): boolean {
  return (
    removedLines >= guard.minRemovedLines &&
    removedLines > guard.removedRatio * Math.max(1, addedLines)
  );
}

export function largeDestructiveRejection(
  path: string,
  removedLines: number,
  addedLines: number,
  guard: { minRemovedLines: number; removedRatio: number },
): string {
  return (
    `[E_LARGE_DESTRUCTIVE_EDIT] In ${path}: this transaction removes ${removedLines} line(s) and adds only ${addedLines} line(s), ` +
    `which exceeds the guard threshold (>= ${guard.minRemovedLines} removed and > ${guard.removedRatio}x the added count). Nothing was modified. ` +
    `Verify the range is what you intend; if this bulk removal is intentional, resend with "allow_large_change": true.`
  );
}
