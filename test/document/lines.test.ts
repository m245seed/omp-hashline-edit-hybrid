import { describe, expect, it } from "vitest";
import { splitTextLines, joinTextLines, preferredEol, hasMixedLineEndings } from "../../src/document/lines";
import { decodeDocument, encodeDocument } from "../../src/document/encoding";

describe("line model (spec §40)", () => {
  it("splits and joins LF content", () => {
    const lines = splitTextLines("one\ntwo\nthree\n");
    expect(lines).toEqual([
      { text: "one", eol: "\n" },
      { text: "two", eol: "\n" },
      { text: "three", eol: "\n" },
    ]);
    expect(joinTextLines(lines)).toBe("one\ntwo\nthree\n");
  });

  it("handles a missing final newline", () => {
    const lines = splitTextLines("one\ntwo");
    expect(lines).toEqual([
      { text: "one", eol: "\n" },
      { text: "two", eol: "" },
    ]);
  });

  it("handles CRLF and CR", () => {
    expect(splitTextLines("a\r\nb\r\n")).toEqual([
      { text: "a", eol: "\r\n" },
      { text: "b", eol: "\r\n" },
    ]);
    expect(splitTextLines("a\rb\r")).toEqual([
      { text: "a", eol: "\r" },
      { text: "b", eol: "\r" },
    ]);
    expect(splitTextLines("a\r\nb\r")).toEqual([
      { text: "a", eol: "\r\n" },
      { text: "b", eol: "\r" },
    ]);
  });

  it("preserves trailing whitespace exactly", () => {
    const lines = splitTextLines("return x; \nreturn x;");
    expect(lines[0]!.text).toBe("return x; ");
    expect(lines[1]!.text).toBe("return x;");
  });

  it("treats an empty file as one empty line (total protocol)", () => {
    const lines = splitTextLines("");
    expect(lines).toEqual([{ text: "", eol: "" }]);
    expect(joinTextLines(lines)).toBe("");
  });

  it("handles blank lines and consecutive separators", () => {
    expect(splitTextLines("a\n\nb\n")).toEqual([
      { text: "a", eol: "\n" },
      { text: "", eol: "\n" },
      { text: "b", eol: "\n" },
    ]);
  });

  it("round-trips through decode/encode", () => {
    for (const content of ["", "abc", "abc\n", "a\nb\nc\n", "a\r\nb\r\n", "a\rb", "a\nb\r\nc\r"]) {
      const doc = decodeDocument(Buffer.from(content, "utf-8"), "t");
      expect(encodeDocument(doc)).toBe(content);
    }
  });

  it("round-trips arbitrary lines through split/join", () => {
    const sample = "line1\r\nline2\nline3\rline4\n\nline6";
    const lines = splitTextLines(sample);
    expect(joinTextLines(lines)).toBe(sample);
    expect(splitTextLines(joinTextLines(lines))).toEqual(lines);
  });

  it("preserves BOM as document metadata, not line 1", () => {
    const doc = decodeDocument(Buffer.from("\uFEFFline1\nline2\n", "utf-8"), "t");
    expect(doc.bom).toBe("\uFEFF");
    expect(doc.lines[0]!.text).toBe("line1");
    expect(encodeDocument(doc)).toBe("\uFEFFline1\nline2\n");
  });
});

describe("preferred line ending (spec §40)", () => {
  it("uses the dominant ending", () => {
    const lines = splitTextLines("a\r\nb\r\nc\nd\n");
    expect(preferredEol(lines)).toBe("\r\n");
  });

  it("uses the first observed on a tie", () => {
    const lines = splitTextLines("a\r\nb\nc\r\nd\n");
    expect(preferredEol(lines)).toBe("\r\n");
    const lines2 = splitTextLines("a\nb\r\nc\nd\r\n");
    expect(preferredEol(lines2)).toBe("\n");
  });

  it("defaults to LF", () => {
    expect(preferredEol(splitTextLines(""))).toBe("\n");
    expect(preferredEol(splitTextLines("abc"))).toBe("\n");
  });

  it("detects mixed endings", () => {
    expect(hasMixedLineEndings(splitTextLines("a\nb\r\n"))).toBe(true);
    expect(hasMixedLineEndings(splitTextLines("a\nb\n"))).toBe(false);
  });
});
