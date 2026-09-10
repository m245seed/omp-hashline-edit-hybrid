import { describe, expect, it } from "vitest";
import { alignSequences } from "../../src/anchors/sequence-map";

describe("sequence alignment (spec §6.1)", () => {
  it("maps equal lines positionally", () => {
    const mapping = alignSequences(["a", "b", "c"], ["a", "b", "c"]);
    expect(mapping.size).toBe(3);
    expect(mapping.get(0)).toBe(0);
    expect(mapping.get(1)).toBe(1);
    expect(mapping.get(2)).toBe(2);
  });

  it("preserves equal lines around an insertion", () => {
    const mapping = alignSequences(
      ["alpha", "beta", "gamma"],
      ["alpha", "new", "beta", "gamma"],
    );
    expect(mapping.get(0)).toBe(0);
    expect(mapping.get(2)).toBe(1);
    expect(mapping.get(3)).toBe(2);
    expect(mapping.has(1)).toBe(false);
  });

  it("preserves equal lines around a deletion", () => {
    const mapping = alignSequences(
      ["alpha", "beta", "gamma"],
      ["alpha", "gamma"],
    );
    expect(mapping.get(0)).toBe(0);
    expect(mapping.get(1)).toBe(2);
  });

  it("is deterministic for huge runs of identical lines", () => {
    const run = new Array<string>(50).fill("}");
    const a = alignSequences(run, run);
    const b = alignSequences(run, run);
    expect([...a]).toEqual([...b]);
    expect(a.size).toBe(50);
  });

  it("handles blank-line runs deterministically", () => {
    const oldSeq = ["", "", "x", ""];
    const newSeq = ["", "x", ""];
    const a = alignSequences(oldSeq, newSeq);
    const b = alignSequences(oldSeq, newSeq);
    expect([...a]).toEqual([...b]);
  });

  it("never maps one old line to two new lines", () => {
    const mapping = alignSequences(["a", "a", "b"], ["a", "a", "a", "b"]);
    const values = [...mapping.values()];
    expect(new Set(values).size).toBe(values.length);
    expect(mapping.size).toBeGreaterThanOrEqual(3);
  });

  it("preserves order", () => {
    const mapping = alignSequences(
      ["1", "2", "3", "4", "5"],
      ["1", "2", "4", "5", "6"],
    );
    const pairs = [...mapping.entries()];
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i]![0]).toBeGreaterThan(pairs[i - 1]![0]);
      expect(pairs[i]![1]).toBeGreaterThan(pairs[i - 1]![1]);
    }
  });

  it("maps moved blocks deterministically by content", () => {
    const oldSeq = ["a", "b", "c", "d"];
    const newSeq = ["c", "d", "a", "b"];
    const a = alignSequences(oldSeq, newSeq);
    const b = alignSequences(oldSeq, newSeq);
    expect([...a]).toEqual([...b]);
    // A maximal LCS (length 2) is preserved — either (a,b) or (c,d).
    expect(a.size).toBe(2);
    const values = [...a.values()].sort();
    expect(values).toEqual(values);
    // Anchors are never duplicated and order is preserved.
    expect(new Set(a.values()).size).toBe(2);
    const pairs = [...a.entries()];
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i]![0]).toBeGreaterThan(pairs[i - 1]![0]);
      expect(pairs[i]![1]).toBeGreaterThan(pairs[i - 1]![1]);
    }
  });
});
