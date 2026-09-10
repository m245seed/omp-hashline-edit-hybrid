/**
 * Full-document reconciliation (spec §7).
 *
 * When the current file checksum differs from the stored snapshot, the
 * anchor engine runs a reconciliation pass: align old exact-line
 * fingerprints against new fingerprints, keep anchors for equal lines,
 * retire anchors of removed/changed lines, and allocate fresh anchors for
 * added/changed lines. External insertions, deletions, and movements all
 * leave untouched lines addressable by their original anchors.
 */

import { AnchorAllocator } from "./allocator";
import { alignSequences, internIds } from "./sequence-map";

export interface StoredLineState {
  anchors: string[];
  /** SHA-256 hex fingerprints of the exact line texts, line-aligned. */
  fingerprints: string[];
}

export interface ReconcileResult {
  anchors: string[];
  /** Anchors that were active before and are not active now. */
  retiredAdded: string[];
  /** new line index -> old line index for lines preserved by the alignment. */
  mapping: Map<number, number>;
}

/**
 * Reconcile a possibly-externally-modified file.
 *
 * `oldState` is the persisted per-file state (or undefined when the file was
 * never seen). `newFingerprints` are the fingerprints of the current lines,
 * and `newTexts` the exact current line texts (used for fresh allocation).
 */
export function reconcileState(
  oldState: StoredLineState | undefined,
  oldRetired: ReadonlySet<string>,
  newTexts: string[],
  newFingerprints: string[],
): ReconcileResult {
  if (newTexts.length !== newFingerprints.length) {
    throw new Error(
      "reconcileState: fingerprints must be line-aligned with texts",
    );
  }
  if (oldState) {
    if (new Set(oldState.anchors).size !== oldState.anchors.length) {
      throw new Error("reconcileState: stored anchors are not unique");
    }
  }
  const allocator = new AnchorAllocator(
    oldState ? new Set(oldState.anchors) : new Set<string>(),
    oldRetired,
  );
  const anchors = new Array<string>(newTexts.length);
  const preservedOld = new Set<number>();
  const mapping = new Map<number, number>();

  if (oldState && oldState.anchors.length === oldState.fingerprints.length) {
    // Convert hex fingerprints to dense integer IDs so Myers diff compares
    // numbers (O(1) ===) instead of 64-char strings (O(64) char loop).
    const [oldIds, newIds] = internIds(oldState.fingerprints, newFingerprints);
    const alignment = alignSequences(oldIds, newIds);
    for (const [newIdx, oldIdx] of alignment) {
      anchors[newIdx] = oldState.anchors[oldIdx]!;
      preservedOld.add(oldIdx);
      mapping.set(newIdx, oldIdx);
    }
  }
  for (let i = 0; i < newTexts.length; i++) {
    if (anchors[i] !== undefined) continue;
    anchors[i] = allocator.allocate(newTexts[i]!);
  }

  const retiredAdded: string[] = [];
  if (oldState) {
    for (let i = 0; i < oldState.anchors.length; i++) {
      if (!preservedOld.has(i)) retiredAdded.push(oldState.anchors[i]!);
    }
  }
  return { anchors, retiredAdded, mapping };
}
