import { describe, expect, it } from "vitest";
import {
  ANCHOR_LEN,
  ANCHOR_RE,
  ANCHOR_SPACE,
  idxToAnchor,
  anchorToIdx,
} from "../../src/anchors/alphabet";

describe("anchor alphabet (spec §3)", () => {
  it("uses exactly 4 characters from A-Za-z0-9", () => {
    expect(ANCHOR_LEN).toBe(4);
    expect(ANCHOR_RE.test("ve7Q")).toBe(true);
    expect(ANCHOR_RE.test("szJ2")).toBe(true);
    expect(ANCHOR_RE.test("kQmA")).toBe(true);
  });

  it("rejects excluded characters", () => {
    for (const bad of ["ab-c", "ab_c", "ab|c", "ab/c", "ab.c", "ab c", "abc", "abcde", "", "ab1!", "ab1é"]) {
      expect(ANCHOR_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("has the 62^4 namespace", () => {
    expect(ANCHOR_SPACE).toBe(62 ** 4);
    expect(ANCHOR_SPACE).toBe(14_776_336);
  });

  it("round-trips indexes", () => {
    expect(anchorToIdx("AAAA")).toBe(0);
    expect(idxToAnchor(0)).toBe("AAAA");
    expect(idxToAnchor(ANCHOR_SPACE - 1)).toBe("9999");
    for (const idx of [0, 1, 61, 62, 3843, 3907, 1234567, ANCHOR_SPACE - 1]) {
      expect(anchorToIdx(idxToAnchor(idx))).toBe(idx);
    }
  });

  it("reports -1 for out-of-alphabet strings", () => {
    expect(anchorToIdx("ab-c")).toBe(-1);
    expect(anchorToIdx("ab|c")).toBe(-1);
  });
});
