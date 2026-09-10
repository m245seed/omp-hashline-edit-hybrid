/**
 * Line fingerprints (spec §4.2, §65).
 *
 * The served-state system compares exact line contents. Fingerprints are
 * SHA-256 of the exact logical line text (UTF-8); trailing whitespace is
 * significant — `"return x;"` and `"return x; "` are different served
 * states. Fingerprints are only used as a compact persisted representation
 * of line identity for reconciliation; in-memory comparisons use the exact
 * text directly.
 */

import { createHash } from "crypto";

export const FINGERPRINT_BYTES = 32;

export function lineFingerprintHex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function decodeFingerprintHexes(blob: Uint8Array): string[] {
  if (blob.length % FINGERPRINT_BYTES !== 0) {
    throw new Error("Corrupt fingerprint blob length");
  }
  const buf = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = blob.length / FINGERPRINT_BYTES;
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const offset = i * FINGERPRINT_BYTES;
    out[i] = buf.toString("hex", offset, offset + FINGERPRINT_BYTES);
  }
  return out;
}

export function fingerprintHexes(texts: string[]): string[] {
  return texts.map(lineFingerprintHex);
}
