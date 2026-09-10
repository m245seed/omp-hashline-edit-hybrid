import { describe, expect, it } from "vitest";
import { decodeText, detectBom, looksBinary } from "../../src/document/encoding";

describe("strict encoding rules (spec §39, §42)", () => {
  it("detects BOMs", () => {
    expect(detectBom(Buffer.from([0xef, 0xbb, 0xbf]))).toBe("utf8");
    expect(detectBom(Buffer.from([0xff, 0xfe]))).toBe("utf16le");
    expect(detectBom(Buffer.from([0xfe, 0xff]))).toBe("utf16be");
    expect(detectBom(Buffer.from([0xff, 0xfe, 0x00, 0x00]))).toBe("utf32le");
    expect(detectBom(Buffer.from([0x00, 0x00, 0xfe, 0xff]))).toBe("utf32be");
    expect(detectBom(Buffer.from([0x61, 0x62]))).toBeUndefined();
  });

  it("decodes plain UTF-8", () => {
    expect(decodeText(Buffer.from("héllo wörld\n", "utf-8"), "t").text).toBe("héllo wörld\n");
  });

  it("strips a UTF-8 BOM and reports it", () => {
    const result = decodeText(Buffer.from("\uFEFFabc\n", "utf-8"), "t");
    expect(result.bom).toBe("\uFEFF");
    expect(result.text).toBe("abc\n");
  });

  it("rejects UTF-16LE", () => {
    expect(() => decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00]), "f.txt")).toThrow(/E_ENCODING_UNSUPPORTED/);
  });

  it("rejects UTF-16BE", () => {
    expect(() => decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x61]), "f.txt")).toThrow(/E_ENCODING_UNSUPPORTED/);
  });

  it("rejects UTF-32", () => {
    expect(() => decodeText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]), "f.txt")).toThrow(/E_ENCODING_UNSUPPORTED/);
    expect(() => decodeText(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x61]), "f.txt")).toThrow(/E_ENCODING_UNSUPPORTED/);
  });

  it("rejects invalid UTF-8 instead of decoding with replacement characters", () => {
    expect(() => decodeText(Buffer.from([0x61, 0x62, 0xc3, 0x28]), "f.txt")).toThrow(/E_ENCODING_UNSUPPORTED/);
  });

  it("rejects binary payloads", () => {
    const buf = Buffer.alloc(64);
    buf.write("not really text", 0);
    buf[20] = 0;
    expect(() => decodeText(buf, "f.bin")).toThrow(/E_BINARY_FILE/);
  });

  it("accepts files with NUL-free binary-ish content only if valid text", () => {
    expect(() => decodeText(Buffer.from("\u0001\u0002\u0003\u0004\u0005", "latin1"), "f")).toThrow(/E_BINARY_FILE/);
  });

  it("looksBinary detects NUL bytes", () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text", "utf-8"))).toBe(false);
  });
});
