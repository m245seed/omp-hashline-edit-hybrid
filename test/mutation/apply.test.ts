import { describe, expect, it } from "vitest"

import { ANCHOR_RE } from "../../src/anchors/alphabet";
import { decodeDocument, encodeDocument } from "../../src/document/encoding";
import { applyTransaction, type EditOp, type InsertOp, wouldEmptyMessage } from "../../src/mutation/apply";
import { hasMixedLineEndings } from "../../src/document/lines";

;

function docOf(content: string) {
  return decodeDocument(Buffer.from(content, "utf-8"), "test");
}

interface Setup {
  doc: ReturnType<typeof docOf>;
  texts: string[];
  anchors: string[];
  retired: Set<string>;
}

function setup(content: string): Setup {
  const doc = docOf(content);
  const texts = doc.lines.map((l) => l.text);
  const anchors: string[] = [];
  const retired = new Set<string>();
  let i = 0;
  for (const _ of texts) {
    anchors.push(`A${String(i).padStart(3, "0")}`);
    i++;
  }
  return { doc, texts, anchors, retired };
}

function edit(start: number, end: number, lines: string[], requestIndex = 0): EditOp {
  return { kind: "edit", start, end, lines, requestIndex };
}

function insert(anchorIndex: number, direction: "before" | "after", lines: string[], requestIndex = 0): InsertOp {
  return { kind: "insert", anchorIndex, direction, lines, requestIndex };
}

function assertInvariants(result: { document: { lines: { text: string }[] }; anchors: string[] }): void {
  const lineCount = result.document.lines.length;
  expect(result.anchors.length).toBe(lineCount);
  for (const anchor of result.anchors) {
    expect(ANCHOR_RE.test(anchor)).toBe(true);
  }
  expect(new Set(result.anchors).size).toBe(lineCount);
}

describe("applyTransaction — replacement (spec §6, §70)", () => {
  it("replaces a single line and preserves everything else", () => {
    const s = setup("function total(items) {\n  let value = 0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return value;\n}\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["  let value = 0.0;"])]);
    expect(encodeDocument(result.document)).toBe("function total(items) {\n  let value = 0.0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return value;\n}\n");
    expect(result.anchors[0]).toBe(s.anchors[0]);
    expect(result.anchors[2]).toBe(s.anchors[2]);
    expect(result.anchors[3]).toBe(s.anchors[3]);
    expect(result.anchors[4]).toBe(s.anchors[4]);
    expect(result.anchors[5]).toBe(s.anchors[5]);
    expect(result.anchors[6]).toBe(s.anchors[6]);
    expect(result.anchors[1]).not.toBe(s.anchors[1]);
    expect(result.retiredAdded).toEqual([s.anchors[1]]);
    assertInvariants(result);
  });

  it("keeps equal lines inside a replaced range (spec §6.1)", () => {
    const s = setup("one\ntwo\nthree\nfour\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 2, ["TWO", "three"])]);
    expect(encodeDocument(result.document)).toBe("one\nTWO\nthree\nfour\n");
    // "three" keeps A002 even though it sits inside the replaced range.
    expect(result.anchors[2]).toBe(s.anchors[2]);
    expect(result.anchors[0]).toBe(s.anchors[0]);
    expect(result.anchors[3]).toBe(s.anchors[3]);
    expect(result.retiredAdded).toEqual([s.anchors[1]]);
    assertInvariants(result);
  });

  it("preserves anchors for equal lines in duplicate runs", () => {
    const s = setup("a\n}\n}\n}\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(2, 3, ["}", "}"])]);
    expect(encodeDocument(result.document)).toBe("a\n}\n}\n}\nb\n");
    expect(result.anchors[0]).toBe(s.anchors[0]);
    expect(result.anchors[4]).toBe(s.anchors[4]);
    expect(new Set(result.anchors.slice(1, 4)).size).toBe(3);
    assertInvariants(result);
  });

  it("deletes a range with empty lines", () => {
    const s = setup("one\ntwo\nthree\nfour\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 2, [])]);
    expect(encodeDocument(result.document)).toBe("one\nfour\n");
    expect(result.retiredAdded).toEqual([s.anchors[1], s.anchors[2]]);
    assertInvariants(result);
  });

  it("applies multiple edits transactionally (spec §70)", () => {
    const s = setup("function total(items) {\n  let value = 0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return value;\n}\n");
    const result = applyTransaction(
      s.doc,
      { anchors: s.anchors, retired: s.retired },
      [
        edit(1, 1, ["  let value = 0.0;"], 0),
        edit(5, 5, ["  return Math.round(value * 100) / 100;"], 1),
      ],
    );
    expect(encodeDocument(result.document)).toBe(
      "function total(items) {\n  let value = 0.0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return Math.round(value * 100) / 100;\n}\n",
    );
    expect(result.anchors[0]).toBe(s.anchors[0]);
    expect(result.anchors[2]).toBe(s.anchors[2]);
    expect(result.anchors[3]).toBe(s.anchors[3]);
    expect(result.anchors[6]).toBe(s.anchors[6]);
    expect(result.retiredAdded.sort()).toEqual([s.anchors[1], s.anchors[5]].sort());
    assertInvariants(result);
  });

  it("rejects overlapping ranges", () => {
    const s = setup("a\nb\nc\nd\ne\n");
    expect(() =>
      applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
        edit(0, 2, ["X"], 0),
        edit(2, 4, ["Y"], 1),
      ]),
    ).toThrow(/E_RANGE_OVERLAP/);
  });

  it("rejects ranges sharing an endpoint line (spec §20)", () => {
    const s = setup("a\nb\nc\nd\ne\n");
    expect(() =>
      applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
        edit(0, 2, ["X"], 0),
        edit(2, 3, ["Y"], 1),
      ]),
    ).toThrow(/E_RANGE_OVERLAP/);
  });

  it("rejects duplicate ranges", () => {
    const s = setup("a\nb\nc\n");
    expect(() =>
      applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
        edit(0, 0, ["X"], 0),
        edit(0, 0, ["Y"], 1),
      ]),
    ).toThrow(/E_RANGE_OVERLAP/);
  });

  it("allows adjacent ranges", () => {
    const s = setup("a\nb\nc\nd\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
      edit(0, 1, ["A", "B"], 0),
      edit(2, 3, ["C", "D"], 1),
    ]);
    expect(encodeDocument(result.document)).toBe("A\nB\nC\nD\n");
    assertInvariants(result);
  });

  it("applies unsorted request ranges in document order", () => {
    const s = setup("a\nb\nc\nd\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
      edit(2, 2, ["C2"], 0),
      edit(0, 0, ["A2"], 1),
    ]);
    expect(encodeDocument(result.document)).toBe("A2\nb\nC2\nd\n");
    assertInvariants(result);
  });
});

describe("applyTransaction — insert (spec §23)", () => {
  it("inserts after an anchor line", () => {
    const s = setup("X\nY\nZ\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [insert(0, "after", ["A", "B"])]);
    expect(encodeDocument(result.document)).toBe("X\nA\nB\nY\nZ\n");
    expect(result.anchors[0]).toBe(s.anchors[0]);
    expect(result.anchors[3]).toBe(s.anchors[1]);
    assertInvariants(result);
  });

  it("inserts before an anchor line", () => {
    const s = setup("X\nY\nZ\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [insert(2, "before", ["P", "Q"])]);
    expect(encodeDocument(result.document)).toBe("X\nY\nP\nQ\nZ\n");
    assertInvariants(result);
  });

  it("orders same-anchor same-direction inserts by request order (spec §23)", () => {
    const s = setup("X\nY\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
      insert(0, "after", ["A"], 0),
      insert(0, "after", ["B"], 1),
    ]);
    expect(encodeDocument(result.document)).toBe("X\nA\nB\nY\n");
  });

  it("inserts at end of file preserving final newline state", () => {
    const s = setup("a\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [insert(1, "after", ["c", "d"])]);
    expect(encodeDocument(result.document)).toBe("a\nb\nc\nd\n");
  });

  it("inserts at end of file without a final newline", () => {
    const s = setup("a\nb");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [insert(1, "after", ["c", "d"])]);
    expect(encodeDocument(result.document)).toBe("a\nb\nc\nd");
  });

  it("rejects inserts inside a replaced range", () => {
    const s = setup("a\nb\nc\nd\n");
    expect(() =>
      applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
        edit(0, 3, ["X"], 0),
        insert(2, "after", ["Y"], 1),
      ]),
    ).toThrow(/E_RANGE_OVERLAP/);
  });
});

describe("applyTransaction — line endings (spec §40)", () => {
  it("preserves untouched CRLF lines exactly", () => {
    const s = setup("a\r\nb\r\nc\r\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])]);
    expect(encodeDocument(result.document)).toBe("a\r\nB\r\nc\r\n");
  });

  it("uses the dominant ending for new lines", () => {
    const s = setup("a\r\nb\r\nc\r\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B", "B2"])]);
    expect(encodeDocument(result.document)).toBe("a\r\nB\r\nB2\r\nc\r\n");
  });

  it("preserves mixed endings outside the edit", () => {
    // \n and \r\n are tied (2 each) — first observed wins per spec §40.
    const s = setup("a\nb\r\nc\nd\r\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])]);
    expect(encodeDocument(result.document)).toBe("a\nB\nc\nd\r\n");
  });

  it("uses the dominant ending when one ending dominates", () => {
    const s = setup("a\nb\r\nc\r\nd\r\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])]);
    expect(encodeDocument(result.document)).toBe("a\nB\r\nc\r\nd\r\n");
  });

  it("preserves the missing-final-newline state at EOF edits", () => {
    const s = setup("a\nb\nc");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(2, 2, ["C", "D"])]);
    expect(encodeDocument(result.document)).toBe("a\nb\nC\nD");
  });

  it("preserves the final newline when replacing the last line", () => {
    const s = setup("a\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B", "B2"])]);
    expect(encodeDocument(result.document)).toBe("a\nB\nB2\n");
  });
});

describe("applyTransaction — multibyte + mixed endings + multiple ops", () => {
  it("preserves exact encoded output, unique anchors, and unchanged anchors outside affected ranges", () => {
    // Multibyte text (emoji = 4 code units via surrogate pair) plus mixed
    // line endings: \n (lines 0,2), \r\n (line 1). \n dominates (2 vs 1).
    const s = setup("αβγ\nδ\r\nε\n");
    const result = applyTransaction(
      s.doc,
      { anchors: s.anchors, retired: s.retired },
      [
        // Replace the multibyte line 0.
        edit(0, 0, ["😀α"], 0),
        // Insert after the CRLF line (index 1).
        insert(1, "after", ["ζ"], 1),
      ],
    );
    // Exact encoded output: new line 0 + dominant \n for its terminator,
    // inserted ζ uses dominant \n, untouched CRLF and ε\n preserved.
    expect(encodeDocument(result.document)).toBe("😀α\nδ\r\nζ\nε\n");
    assertInvariants(result);
    // Untouched lines (index 1 = δ, index 2 = ε) keep their anchors; only their
    // positions shift due to the inserted line.
    expect(result.anchors[1]).toBe(s.anchors[1]); // δ (was CRLF, untouched)
    expect(result.anchors[3]).toBe(s.anchors[2]); // ε (untouched)
    // The replaced line 0 and inserted line get fresh anchors.
    expect(result.anchors[0]).not.toBe(s.anchors[0]);
    expect(result.anchors[2]).not.toBe(s.anchors[1]);
    expect(result.anchors[2]).not.toBe(s.anchors[2]);
    expect(result.retiredAdded).toEqual([s.anchors[0]]);
  });
});

describe("applyTransaction — final_newline policy (spec §41)", () => {
  it("present adds a final newline", () => {
    const s = setup("a\nb");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])], { finalNewline: "present" });
    expect(encodeDocument(result.document)).toBe("a\nB\n");
  });

  it("absent removes the final newline", () => {
    const s = setup("a\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])], { finalNewline: "absent" });
    expect(encodeDocument(result.document)).toBe("a\nB");
  });

  it("preserve keeps the current final newline state", () => {
    const s = setup("a\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])], { finalNewline: "preserve" });
    expect(encodeDocument(result.document)).toBe("a\nB\n");
  });

  it("flags final_newline as unused when no edit reaches EOF", () => {
    const s = setup("a\nb\nc\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(0, 0, ["A"])], { finalNewline: "present" });
    expect(result.unusedFinalNewline).toBe(true);
    expect(encodeDocument(result.document)).toBe("A\nb\nc\n");
  });
});

describe("applyTransaction — safety (spec §21, §22)", () => {
  it("returns noop for identical content and changes nothing", () => {
    const s = setup("a\nb\nc\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["b"])]);
    expect(result.noop).toBe(true);
    expect(result.anchors).toEqual(s.anchors);
    expect(result.retiredAdded).toEqual([]);
    expect(result.metrics.classification).toBe("noop");
    expect(result.metrics.editsNoop).toBe(1);
    expect(result.metrics.editsApplied).toBe(0);
  });

  it("counts mixed noop and real edits", () => {
    const s = setup("a\nb\nc\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [
      edit(0, 0, ["a"], 0),
      edit(1, 1, ["B"], 1),
    ]);
    expect(result.noop).toBe(false);
    expect(result.metrics.editsNoop).toBe(1);
    expect(result.metrics.editsApplied).toBe(1);
  });

  it("counts an edit as applied when only the terminator bytes change", () => {
    // Mixed endings: the range's final line keeps its original \r\n, but a
    // same-text replacement recomputes it with the dominant \n — the splice
    // is not a byte-level no-op even though the texts are equal.
    const s = setup("a\nb\r\nc\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["b"])]);
    expect(result.noop).toBe(false);
    expect(result.metrics.editsApplied).toBe(1);
    expect(result.metrics.editsNoop).toBe(0);
    expect(encodeDocument(result.document)).toBe("a\nb\nc\n");
  });

  it("rejects emptying a non-empty file", () => {
    const s = setup("a\nb\n");
    expect(() =>
      applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(0, 1, [])]),
    ).toThrow(wouldEmptyMessage());
  });

  it("allows deleting content from an empty file (no-op)", () => {
    const s = setup("");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(0, 0, [])]);
    expect(result.noop).toBe(true);
  });

  it("treats empty inserts as no-ops", () => {
    const s = setup("a\nb\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [insert(0, "after", [])]);
    expect(result.noop).toBe(true);
  });
});

describe("applyTransaction — diff model (spec §26)", () => {
  it("produces served context and added rows plus removed rows with old anchors", () => {
    const s = setup("function run() {\n  return oldValue;\n}\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["  return newValue;"])]);
    const rows = result.diffRows;
    const text = rows.map((r) => `${r.prefix}${r.anchor}${"│"}${r.text}`).join("\n");
    expect(text).toContain(`-${s.anchors[1]}│  return oldValue;`);
    expect(text).toContain(`+${result.anchors[1]}│  return newValue;`);
    expect(text).toContain(` ${s.anchors[0]}│function run() {`);
    expect(text).toContain(` ${s.anchors[2]}│}`);
    const minus = rows.filter((r) => r.prefix === "-");
    expect(minus.length).toBe(1);
    expect(minus[0]!.anchor).toBe(s.anchors[1]);
  });

  it("omits deleted rows from the served set", () => {
    const s = setup("a\nb\nc\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(1, 1, ["B"])]);
    const served = result.diffRows.filter((r) => r.prefix !== "-" && r.anchor !== "");
    expect(served.every((r) => r.prefix === " " || r.prefix === "+")).toBe(true);
  });

  it("renders head + ellipsis + tail for a long run between two changes", () => {
    const s = setup("c1\nu1\nu2\nu3\nu4\nu5\nu6\nu7\nc2\n");
    const result = applyTransaction(
      s.doc,
      { anchors: s.anchors, retired: s.retired },
      [edit(0, 0, ["C1"], 0), edit(8, 8, ["C2"], 1)],
    );
    const newAnchors = result.anchors;
    const seq = result.diffRows.map((r) => `${r.prefix}:${r.text}`);
    // Exactly one ellipsis; the window is the two lines adjacent to each hunk.
    expect(seq).toEqual([
      "-:c1",
      "+:C1",
      " :u1",
      " :u2",
      " :...",
      " :u6",
      " :u7",
      "-:c2",
      "+:C2",
    ]);
    // Context rows carry the true anchors of the lines they show.
    const ctxRows = result.diffRows.filter((r) => r.prefix === " " && r.anchor !== "");
    expect(ctxRows.map((r) => r.text)).toEqual(["u1", "u2", "u6", "u7"]);
    expect(ctxRows[0]!.anchor).toBe(newAnchors[1]);
    expect(ctxRows[3]!.anchor).toBe(newAnchors[7]);
  });

  it("renders the lines adjacent to the first change for a long leading run", () => {
    const s = setup("u1\nu2\nu3\nu4\nu5\nc1\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(5, 5, ["C1"])]);
    const seq = result.diffRows.map((r) => `${r.prefix}:${r.text}`);
    expect(seq).toEqual([" :...", " :u4", " :u5", "-:c1", "+:C1"]);
  });
});

describe("applyTransaction — anchors never collide with retired", () => {
  it("avoids retired anchors in fresh allocation", () => {
    const s = setup("a\nb\n");
    const retired = new Set<string>([s.anchors[0]!, s.anchors[1]!, "Ab12", "Cd34"]);
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired }, [edit(0, 1, ["X", "Y"])]);
    for (const anchor of result.anchors) {
      expect(retired.has(anchor)).toBe(false);
    }
    expect(result.retiredAdded.sort()).toEqual([s.anchors[0], s.anchors[1]].sort());
    assertInvariants(result);
  });

  it("never reuses an anchor within a transaction", () => {
    const s = setup("}\n}\n}\n}\n");
    const result = applyTransaction(s.doc, { anchors: s.anchors, retired: s.retired }, [edit(0, 3, ["}", "}", "}", "}"])]);
    expect(new Set(result.anchors).size).toBe(4);
  });
});

describe("applyTransaction — mixed ending warning data", () => {
  it("keeps hasMixedLineEndings observable", () => {
    const s = setup("a\nb\r\n");
    expect(hasMixedLineEndings(s.doc.lines)).toBe(true);
  });
});
