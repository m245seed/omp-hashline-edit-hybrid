import { beforeEach, describe, expect, it } from "vitest";
import {
  resetServed,
  serveLine,
  serveLines,
  servedText,
  markStale,
  isStale,
  clearServedPath,
  pruneServedPath,
  reconcileServed,
} from "../../src/served/ledger";

beforeEach(() => {
  resetServed();
});

describe("served ledger (spec §8, §9, §37)", () => {
  it("tracks stale markers", () => {
    expect(isStale("/p/f.ts", "Ab12")).toBe(false);
    markStale("/p/f.ts", "Ab12");
    expect(isStale("/p/f.ts", "Ab12")).toBe(true);
    // Per-path scoping.
    expect(isStale("/p/other.ts", "Ab12")).toBe(false);
  });

  it("clears a path entirely", () => {
    serveLine("/p/f.ts", "Ab12", "x");
    markStale("/p/f.ts", "Cd34");
    clearServedPath("/p/f.ts");
    expect(servedText("/p/f.ts", "Ab12")).toBeUndefined();
    expect(isStale("/p/f.ts", "Cd34")).toBe(false);
  });

  it("prunes only non-matching entries after a write", () => {
    serveLine("/p/f.ts", "Ab12", "same");
    serveLine("/p/f.ts", "Cd34", "old");
    pruneServedPath(
      "/p/f.ts",
      new Map([
        ["Ab12", "same"],
        ["Ef56", "new"],
      ]),
    );
    expect(servedText("/p/f.ts", "Ab12")).toBe("same");
    expect(servedText("/p/f.ts", "Cd34")).toBeUndefined();
  });

  it("reconcileServed transfers authorization and marks changed lines stale", () => {
    serveLine("/p/f.ts", "A000", "start");
    serveLine("/p/f.ts", "A001", "middle");
    serveLine("/p/f.ts", "A002", "end");
    // External change: middle became MIDDLE (new anchor B111); start/end kept.
    reconcileServed(
      "/p/f.ts",
      ["A000", "A001", "A002"],
      new Map([
        [0, 0],
        [2, 2],
      ]),
      ["A000", "B111", "A002"],
      ["start", "MIDDLE", "end"],
    );
    expect(servedText("/p/f.ts", "A000")).toBe("start");
    expect(servedText("/p/f.ts", "A002")).toBe("end");
    expect(isStale("/p/f.ts", "B111")).toBe(true);
    expect(isStale("/p/f.ts", "A000")).toBe(false);
  });

  it("does not mark lines stale when nothing was served before", () => {
    reconcileServed(
      "/p/f.ts",
      ["A000", "A001"],
      new Map([[0, 0]]),
      ["A000", "B111"],
      ["start", "MIDDLE"],
    );
    expect(isStale("/p/f.ts", "B111")).toBe(false);
  });

  it("transfers authorization when a line keeps its text under a new anchor", () => {
    serveLine("/p/f.ts", "A000", "same");
    reconcileServed("/p/f.ts", ["A000"], new Map([[0, 0]]), ["B222"], ["same"]);
    expect(servedText("/p/f.ts", "B222")).toBe("same");
  });
});

describe("served window caps (plan § Memory Management)", () => {
  it("evicts the oldest per-file entries at the cap without touching other files", () => {
    const path = "/p/big.ts";
    for (let i = 0; i < 5000; i++) serveLine(path, `A${i}`, `t${i}`);
    serveLine("/p/other.ts", "Zz99", "keep");
    const evicted = serveLines(path, [{ anchor: "B001", exactText: "new" }]);
    expect(evicted).toBe(0);
    expect(servedText(path, "A0")).toBeUndefined();
    expect(servedText(path, "A1")).toBe("t1");
    expect(servedText(path, "A4999")).toBe("t4999");
    expect(servedText(path, "B001")).toBe("new");
    expect(servedText("/p/other.ts", "Zz99")).toBe("keep");
  });

  it("reports rows from the same call that overflow the per-file window", () => {
    const entries = [];
    for (let i = 0; i < 5010; i++) {
      entries.push({
        anchor: `B${String(i).padStart(4, "0")}`,
        exactText: `x${i}`,
      });
    }
    const evicted = serveLines("/p/huge.ts", entries);
    expect(evicted).toBe(10);
    expect(servedText("/p/huge.ts", "B0000")).toBeUndefined();
    expect(servedText("/p/huge.ts", "B0009")).toBeUndefined();
    expect(servedText("/p/huge.ts", "B0010")).toBe("x10");
    expect(servedText("/p/huge.ts", "B5009")).toBe("x5009");
  });

  it("enforces the global cap across files", () => {
    for (let f = 0; f < 4; f++) {
      for (let i = 0; i < 5000; i++) serveLine(`/p/f${f}.ts`, `A${i}`, `t${i}`);
    }
    // Refresh every entry in f0 after the other files were populated. A
    // global LRU must evict f1's oldest entry, not f0's merely because f0 was
    // inserted first.
    for (let i = 0; i < 5000; i++) serveLine("/p/f0.ts", `A${i}`, `t${i}`);
    // Total is exactly 20000; one more entry pushes it over globally and
    // the oldest entry (f1's A0) is evicted across files.
    const evicted = serveLines("/p/f4.ts", [
      { anchor: "N001", exactText: "new" },
    ]);
    expect(evicted).toBe(0);
    expect(servedText("/p/f0.ts", "A0")).toBe("t0");
    expect(servedText("/p/f1.ts", "A0")).toBeUndefined();
    expect(servedText("/p/f0.ts", "A4999")).toBe("t4999");
    expect(servedText("/p/f4.ts", "N001")).toBe("new");
  });

  it("stale markers are not capped (E_RANGE_STALE fidelity)", () => {
    for (let i = 0; i < 5005; i++) markStale("/p/s.ts", `S${i}`);
    expect(isStale("/p/s.ts", "S0")).toBe(true);
    expect(isStale("/p/s.ts", "S5004")).toBe(true);
  });

  it("reconcileServed degrades conservatively on non-monotone mappings", () => {
    serveLine("/p/f.ts", "A001", "middle");
    // Crossing (hypothetical) mapping: new0→old2, new2→old0; the unmapped
    // new line between them must still see the served old line in its gap.
    reconcileServed(
      "/p/f.ts",
      ["A000", "A001", "A002"],
      new Map([
        [0, 2],
        [2, 0],
      ]),
      ["A000", "B111", "A002"],
      ["start", "MIDDLE", "end"],
    );
    expect(isStale("/p/f.ts", "B111")).toBe(true);
  });

  it("snapshots served entries before transfers can evict sources", () => {
    const path = "/p/reconcile.ts";
    const oldAnchors: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const anchor = `A${i}`;
      oldAnchors.push(anchor);
      serveLine(path, anchor, `t${i}`);
    }
    reconcileServed(
      path,
      oldAnchors,
      new Map([
        [0, 4999],
        [1, 0],
      ]),
      ["B000", "B001"],
      ["t4999", "t0"],
    );
    expect(servedText(path, "B001")).toBe("t0");
  });
});
