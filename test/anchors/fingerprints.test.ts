import { describe, expect, it } from "vitest"

import {
  lineFingerprintHex,
  decodeFingerprintHexes,
  FINGERPRINT_BYTES,
} from "../../src/anchors/fingerprints";

;

describe("fingerprints (spec §4.2)", () => {
  it("hashes exact line text; trailing whitespace is significant", () => {
    expect(lineFingerprintHex("return x;")).not.toBe(lineFingerprintHex("return x; "));
    expect(lineFingerprintHex("a")).toBe(lineFingerprintHex("a"));
  });

  it("decodes a compact blob of concatenated digests", () => {
    const texts = ["a", "", "  b", "héllo"];
    const blob = Buffer.concat(texts.map((t) => Buffer.from(lineFingerprintHex(t), "hex")));
    expect(blob.length).toBe(texts.length * FINGERPRINT_BYTES);
    expect(decodeFingerprintHexes(blob)).toEqual(texts.map(lineFingerprintHex));
  });

  it("rejects corrupt blob lengths", () => {
    expect(() => decodeFingerprintHexes(Buffer.alloc(10))).toThrow(/Corrupt/);
  });
});
