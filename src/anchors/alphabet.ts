/**
 * Anchor alphabet (spec §3): 4 characters from A-Za-z0-9.
 *
 * The namespace is 62^4 = 14,776,336 anchors, large enough that retired
 * anchors are effectively never reused during normal project lifetimes.
 */

export const ANCHOR_LEN = 4;

export const ALPH =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const ANCHOR_RE = /^[A-Za-z0-9]{4}$/;

export const ANCHOR_CLASS = "[A-Za-z0-9]{4}";

export const HASH_SEP = "│";

export const ANCHOR_SPACE = ALPH.length ** ANCHOR_LEN;

/**
 * Fixed deterministic probe stride. Coprime with 62^4 = 2^4 * 31^4
 * (odd, and 3907 mod 31 = 1), so probing visits the whole namespace.
 */
export const ANCHOR_PROBE_STRIDE = ALPH.length ** 2 + ALPH.length + 1;

export function idxToAnchor(idx: number): string {
  let out = "";
  let value = idx;
  for (let j = 0; j < ANCHOR_LEN; j++) {
    out = ALPH[value % ALPH.length]! + out;
    value = Math.floor(value / ALPH.length);
  }
  return out;
}

/** Returns -1 for strings outside the anchor alphabet (callers check length first). */
export function anchorToIdx(anchor: string): number {
  let idx = 0;
  for (let j = 0; j < anchor.length; j++) {
    const charIdx = ALPH.indexOf(anchor[j]!);
    if (charIdx < 0) return -1;
    idx = idx * ALPH.length + charIdx;
  }
  return idx;
}
