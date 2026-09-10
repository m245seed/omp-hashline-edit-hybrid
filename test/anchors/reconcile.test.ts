import { describe, expect, it } from "vitest"

import { fingerprintHexes } from "../../src/anchors/fingerprints";
import { reconcileState } from "../../src/anchors/reconcile";
import { ANCHOR_RE } from "../../src/anchors/alphabet";

;

function state(texts: string[]): { anchors: string[]; fingerprints: string[] } {
  return { anchors: texts.map((_, i) => `A${String(i).padStart(3, "0")}`), fingerprints: fingerprintHexes(texts) };
}

describe("reconciliation (spec §7)", () => {
  it("allocates anchors for a brand-new file", () => {
    const result = reconcileState(undefined, new Set(), ["a", "b"], fingerprintHexes(["a", "b"]));
    expect(result.anchors.length).toBe(2);
    for (const anchor of result.anchors) {
      expect(ANCHOR_RE.test(anchor)).toBe(true);
    }
    expect(result.retiredAdded).toEqual([]);
  });

  it("keeps anchors for equal lines on external insertion", () => {
    const old = state(["alpha", "beta", "gamma"]);
    const newTexts = ["alpha", "new", "beta", "gamma"];
    const result = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    // alpha, beta, gamma keep their anchors; the inserted line is new.
    expect(result.anchors[0]).toBe("A000");
    expect(result.anchors[2]).toBe("A001");
    expect(result.anchors[3]).toBe("A002");
    expect(ANCHOR_RE.test(result.anchors[1]!)).toBe(true);
    expect(result.retiredAdded).toEqual([]);
  });

  it("retires anchors of externally deleted lines", () => {
    const old = state(["alpha", "beta", "gamma"]);
    const newTexts = ["alpha", "gamma"];
    const result = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    expect(result.anchors[0]).toBe("A000");
    expect(result.anchors[1]).toBe("A002");
    expect(result.retiredAdded).toEqual(["A001"]);
  });

  it("retires changed lines and allocates fresh anchors", () => {
    const old = state(["start", "middle", "end"]);
    const newTexts = ["start", "MIDDLE", "end"];
    const result = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    expect(result.anchors[0]).toBe("A000");
    expect(result.anchors[2]).toBe("A002");
    expect(result.retiredAdded).toEqual(["A001"]);
    expect(ANCHOR_RE.test(result.anchors[1]!)).toBe(true);
    expect(result.anchors[1]).not.toBe("A001");
  });

  it("preserves anchors through external movement", () => {
    const old = state(["a", "b", "c", "d"]);
    const newTexts = ["c", "d", "a", "b"];
    const result1 = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    const result2 = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    // Deterministic: repeated runs produce the identical mapping.
    expect(result1.anchors).toEqual(result2.anchors);
    // A maximal-length LCS (2 of 4 lines) keeps its anchors; nothing else is
    // retired or duplicated.
    const kept = result1.anchors.filter((a) => old.anchors.includes(a));
    expect(kept.length).toBe(2);
    expect(new Set(kept).size).toBe(2);
    expect(result1.retiredAdded.length).toBe(2);
  });

  it("keeps equal lines anchored in duplicate-heavy files", () => {
    const texts = ["}", "}", "}", "", ""];
    const old = state(texts);
    const result = reconcileState(old, new Set(), texts, fingerprintHexes(texts));
    expect(result.anchors).toEqual(old.anchors);
    expect(result.retiredAdded).toEqual([]);
  });

  it("excludes retired anchors from fresh allocation", () => {
    const old = state(["a", "b"]);
    const result = reconcileState(old, new Set(["A000", "A001", "Ab12"]), ["x", "y"], fingerprintHexes(["x", "y"]));
    expect(result.retiredAdded).toEqual(["A000", "A001"]);
    for (const anchor of result.anchors) {
      expect(["A000", "A001", "Ab12"].includes(anchor)).toBe(false);
    }
  });

  it("preserves equal lines inside a duplicate run (spec §6.1)", () => {
    // Replace `a b b c` with `a b c` — the mapping must not shuffle which
    // duplicate keeps its anchor between runs.
    const old = state(["a", "b", "b", "c"]);
    const newTexts = ["a", "b", "c"];
    const result1 = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    const result2 = reconcileState(old, new Set(), newTexts, fingerprintHexes(newTexts));
    expect(result1.anchors).toEqual(result2.anchors);
    expect(new Set(result1.anchors).size).toBe(3);
  });
});
