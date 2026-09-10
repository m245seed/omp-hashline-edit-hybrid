import { beforeEach, describe, expect, it } from "vitest";
import { renderDiff } from "../../src/render/engine";
import { resetServed, servedText, serveLines } from "../../src/served/ledger";
import type { DiffRow } from "../../src/mutation/apply";
const PATH = "/p/f.ts";

function row(prefix: DiffRow["prefix"], anchor: string, text: string): DiffRow {
  return { prefix, anchor, text };
}

beforeEach(() => {
  resetServed();
});

describe("bounded diff rendering (spec §26, PH-OUTPUT-003..007)", () => {
  it("summarizes oversized removed rows and never serves them", () => {
    const huge = "y".repeat(200 * 1024 + 1);
    const result = renderDiff([
      row("-", "Ab12", huge),
      row("+", "Cd34", "replacement"),
    ]);
    // Pure render: no serving until caller serves
    expect(servedText(PATH, "Cd34")).toBeUndefined();
    serveLines(PATH, result.served);
    expect(result.text).toContain("[removed diff row omitted:");
    expect(result.text).not.toContain(huge);
    expect(result.text).toContain("+Cd34│replacement");
    // Historical rows are never served; retained current rows are.
    expect(servedText(PATH, "Ab12")).toBeUndefined();
    expect(servedText(PATH, "Cd34")).toBe("replacement");
    expect(result.servedRows).toBe(1);
  });

  it("truncates between complete rows at the byte budget and drops serving", () => {
    // Each current row is ~1KB; 400 rows exceed the 256KB diff budget.
    const rows: DiffRow[] = [];
    for (let i = 0; i < 400; i++) {
      rows.push(row("+", `A${String(i).padStart(3, "0")}`, `${i}:${"k".repeat(1000)}`));
    }
    const result = renderDiff(rows);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[diff output truncated:");
    // Retained rows are contiguous complete rows; dropped rows are not served.
    const retainedAnchors = result.served.map((s) => s.anchor);
    expect(retainedAnchors.length).toBeGreaterThan(0);
    expect(retainedAnchors.length).toBeLessThan(400);
    serveLines(PATH, result.served);
    expect(servedText(PATH, "A399")).toBeUndefined();
    expect(result.servedRows).toBe(retainedAnchors.length);
  });
  it("is pure and does not serve until caller does", () => {
    const result = renderDiff([row("+", "Ab12", "hello")]);
    expect(servedText(PATH, "Ab12")).toBeUndefined();
    serveLines(PATH, result.served);
    expect(servedText(PATH, "Ab12")).toBe("hello");
  });
});
