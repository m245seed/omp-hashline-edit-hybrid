import { beforeEach, describe, expect, it } from "vitest";
import {
  staleAnchorMessage,
  unknownAnchorMessage,
  reversedRangeMessage,
} from "../../src/mutation/resolve";
import { resetServed, servedText } from "../../src/served/ledger";

beforeEach(() => {
  resetServed();
});

describe("anchor resolution (spec §10)", () => {
  const anchors = ["A000", "A001", "A002", "A003"];

  it("resolves anchors by identity, not position", () => {
    const index = new Map(anchors.map((a, i) => [a, i] as [string, number]));
    expect(index.get("A002")).toBe(2);
    expect(index.get("A000")).toBe(0);
  });

  it("does not resolve unknown anchors", () => {
    const index = new Map(anchors.map((a, i) => [a, i] as [string, number]));
    expect(index.get("Z999")).toBeUndefined();
  });

  it("stale anchor messages serve fresh context", () => {
    const message = staleAnchorMessage("/tmp/f.ts", "Z999", anchors, ["a", "b", "c", "d"]);
    expect(message).toContain("[E_ANCHOR_STALE]");
    expect(message).toContain("Nothing was modified.");
    expect(servedText("/tmp/f.ts", "A000")).toBe("a");
    expect(servedText("/tmp/f.ts", "A001")).toBe("b");

  });
  it("reports unknown anchors as E_ANCHOR_NOT_SERVED without a stale claim", () => {
    const message = unknownAnchorMessage("/tmp/f.ts", "Zz9z", ["WR4y", "A001"]);
    expect(message).toContain("[E_ANCHOR_NOT_SERVED]");
    expect(message).toContain("never allocated");
    expect(message).not.toContain("file content changed");
    expect(message).toContain("Use read()");
  });

  it("suggests the unique case-insensitive near-match", () => {
    const message = unknownAnchorMessage("/tmp/f.ts", "wr4Y", ["WR4y", "A001"]);
    expect(message).toContain('Did you mean "WR4y"?');
  });

  it("stays silent when case-folded anchors collide", () => {
    const message = unknownAnchorMessage("/tmp/f.ts", "Ab12", ["AB12", "ab12"]);
    expect(message).not.toContain("Did you mean");
  });

  it("shows and serves the complete text of long lines (spec §8/§9)", () => {
    const long = "z".repeat(500);
    const texts = ["one", long, "three"];
    const many = ["A000", "A001", "A002"];
    const message = staleAnchorMessage("/tmp/long.ts", "Z999", many, texts);
    const row = message.split("\n").find((l) => l.startsWith("A001│"))!;
    // The displayed row carries the full line — no clipping — ...
    expect(row).toBe(`A001│${long}`);
    // ... and exactly that text is served.
    expect(servedText("/tmp/long.ts", "A001")).toBe(long);
    expect(row.length).toBe(4 + 1 + long.length);
  });

  it("omits and does not serve oversized lines in stale feedback", () => {
    const huge = "x".repeat(300 * 1024);
    const texts = ["one", huge, "three"];
    const many = ["A000", "A001", "A002"];
    const message = staleAnchorMessage("/tmp/huge.ts", "Z999", many, texts);
    expect(message).toContain("[Line 2 omitted:");
    expect(message).not.toContain("xxxxx");
    expect(servedText("/tmp/huge.ts", "A001")).toBeUndefined();
    expect(servedText("/tmp/huge.ts", "A000")).toBe("one");
  });

  it("reversed range message never swaps anchors (spec §16)", () => {
    const message = reversedRangeMessage("f.ts", "ZZ99", "AA11");
    expect(message).toContain("[E_RANGE_REVERSED]");
    expect(message).toContain("Range start occurs after range end");
    expect(message).toContain("Nothing was modified.");
    expect(message).toContain("were not swapped");
  });
});
