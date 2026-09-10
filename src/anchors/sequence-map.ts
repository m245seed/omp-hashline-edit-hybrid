/**
 * Deterministic sequence alignment (spec §6.1, §7.1).
 *
 * A deterministic Myers-style diff (jsdiff `diffArrays`) aligns two line
 * sequences. Equal lines map positionally; the result is deterministic for
 * repeated lines (e.g. runs of `}`), preserves order, maximizes preservation,
 * and never maps one old line to two new lines.
 */

import * as Diff from "diff";

/** Dense intern table shared by both sequences: distinct strings ->
 * consecutive small integers, so Myers diff compares with O(1) === instead
 * of string equality. One table across both sides preserves cross-sequence
 * identity — separate tables would alias distinct strings positionally. */
export function internIds(
  oldSeq: readonly string[],
  newSeq: readonly string[],
): [number[], number[]] {
  const idByStr = new Map<string, number>();
  let nextId = 1;
  const toId = (s: string): number => {
    let id = idByStr.get(s);
    if (id === undefined) {
      id = nextId++;
      idByStr.set(s, id);
    }
    return id;
  };
  return [oldSeq.map(toId), newSeq.map(toId)];
}

/**
 * Returns newIndex -> oldIndex for lines that are equal in both sequences.
 * Lines not present in the map are new (allocated fresh); old lines that are
 * not mapped are removed (retired).
 */
export function alignSequences<T>(
  oldSeq: readonly T[],
  newSeq: readonly T[],
): Map<number, number> {
  const n = oldSeq.length;
  if (n === newSeq.length) {
    let identical = true;
    for (let i = 0; i < n; i++) {
      if (oldSeq[i] !== newSeq[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      const mapping = new Map<number, number>();
      for (let i = 0; i < n; i++) mapping.set(i, i);
      return mapping;
    }
  }

  // Prefix and suffix trimming
  let prefix = 0;
  while (prefix < oldSeq.length && prefix < newSeq.length && oldSeq[prefix] === newSeq[prefix]) {
    prefix++;
  }
  let oldSuffix = oldSeq.length - 1;
  let newSuffix = newSeq.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldSeq[oldSuffix] === newSeq[newSuffix]) {
    oldSuffix--;
    newSuffix--;
  }

  const mapping = new Map<number, number>();
  for (let i = 0; i < prefix; i++) {
    mapping.set(i, i);
  }

  const oldMid = oldSeq.slice(prefix, oldSuffix + 1);
  const newMid = newSeq.slice(prefix, newSuffix + 1);

  if (oldMid.length > 0 && newMid.length > 0) {
    const parts = Diff.diffArrays(oldMid as T[], newMid as T[]);
    let oldPos = prefix;
    let newPos = prefix;
    for (const part of parts) {
      const count = part.value.length;
      if (part.added) {
        newPos += count;
      } else if (part.removed) {
        oldPos += count;
      } else {
        for (let i = 0; i < count; i++) {
          mapping.set(newPos + i, oldPos + i);
        }
        oldPos += count;
        newPos += count;
      }
    }
  }

  const suffixCount = oldSeq.length - 1 - oldSuffix;
  for (let i = 0; i < suffixCount; i++) {
    mapping.set(newSeq.length - suffixCount + i, oldSeq.length - suffixCount + i);
  }

  return mapping;
}
