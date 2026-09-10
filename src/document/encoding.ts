/**
 * Strict text-encoding rules (spec §39).
 *
 * Only UTF-8 (with or without BOM) is supported. UTF-16/32 and arbitrary
 * invalid UTF-8 are rejected instead of being decoded with replacement
 * characters and silently rewritten, because silently transcoding violates
 * exact-edit semantics.
 */
import { stat } from "fs/promises";
import { MAX_BYTES, MAX_LINES, SNIFF_BYTES } from "../constants";
import { formatSize } from "../utils";
import { splitTextLines, joinTextLines, type Document } from "./lines";

export type UtfBom = "utf8" | "utf16le" | "utf16be" | "utf32le" | "utf32be";

export function detectBom(raw: Uint8Array): UtfBom | undefined {
  if (
    raw.length >= 4 &&
    raw[0] === 0xff &&
    raw[1] === 0xfe &&
    raw[2] === 0x00 &&
    raw[3] === 0x00
  ) {
    return "utf32le";
  }
  if (
    raw.length >= 4 &&
    raw[0] === 0x00 &&
    raw[1] === 0x00 &&
    raw[2] === 0xfe &&
    raw[3] === 0xff
  ) {
    return "utf32be";
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return "utf16le";
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return "utf16be";
  if (
    raw.length >= 3 &&
    raw[0] === 0xef &&
    raw[1] === 0xbb &&
    raw[2] === 0xbf
  ) {
    return "utf8";
  }
  return undefined;
}

export function looksBinary(raw: Uint8Array): boolean {
  const sample = raw.subarray(0, SNIFF_BYTES);
  // Single-pass scan: check NUL byte and count control chars together
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

// Reuse a single TextDecoder to avoid per-call allocation and GC pressure.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict UTF-8 decode. Throws TypeError on invalid sequences. */
export function decodeUtf8Strict(raw: Uint8Array): string {
  return utf8Decoder.decode(raw);
}

/**
 * Decode raw bytes to text, enforcing the hybrid encoding rules.
 *
 * Returns `{ bom, text }` where `bom` is "\uFEFF" for a UTF-8 BOM (never part
 * of line 1; spec §42) and `text` excludes the BOM.
 *
 * Throws `[E_ENCODING_UNSUPPORTED]` for UTF-16/32 and invalid UTF-8, and
 * `[E_BINARY_FILE]` for binary payloads.
 */
export function decodeText(
  raw: Uint8Array,
  pathLabel: string,
): { bom: string; text: string } {
  if (raw.byteLength > MAX_BYTES) {
    throw new Error(
      `[E_FILE_TOO_LARGE] ${pathLabel} is ${formatSize(raw.byteLength)}, exceeding the ${formatSize(MAX_BYTES)} edit limit.`,
    );
  }
  const bom = detectBom(raw);
  if (
    bom === "utf16le" ||
    bom === "utf16be" ||
    bom === "utf32le" ||
    bom === "utf32be"
  ) {
    throw new Error(
      `[E_ENCODING_UNSUPPORTED] ${pathLabel} is ${bom === "utf16le" ? "UTF-16LE" : bom === "utf16be" ? "UTF-16BE" : bom === "utf32le" ? "UTF-32LE" : "UTF-32BE"} encoded. The hybrid editor only supports UTF-8 (with or without BOM).`,
    );
  }
  if (looksBinary(raw)) {
    throw new Error(
      `[E_BINARY_FILE] ${pathLabel} appears to be a binary file and cannot be edited with the hashline editor.`,
    );
  }
  const payload = bom === "utf8" ? raw.subarray(3) : raw;
  let text: string;
  try {
    text = decodeUtf8Strict(payload);
  } catch {
    throw new Error(
      `[E_ENCODING_UNSUPPORTED] ${pathLabel} contains invalid UTF-8. The hybrid editor refuses to rewrite it; use write or another tool for non-UTF-8 content.`,
    );
  }
  return { bom: bom === "utf8" ? "\uFEFF" : "", text };
}

/**
 * Decode raw file bytes into a Document. A zero-byte file becomes a single
 * empty logical line so the anchored protocol is total. BOM is metadata, not
 * line 1 (spec §42).
 */
export function decodeDocument(raw: Uint8Array, pathLabel: string): Document {
  const { bom, text } = decodeText(raw, pathLabel);
  return { bom, lines: splitTextLines(text) };
}

/**
 * Encode a Document back to raw bytes. This is the only place BOM and line
 * terminators are recombined; untouched lines keep their exact terminators.
 */
export function encodeDocument(doc: Document): string {
  return doc.bom + joinTextLines(doc.lines);
}

/**
 * File-kind checks and resource limits (spec §12, §53).
 *
 * The hybrid is stricter than the pro implementation: only regular text
 * files are readable; directories, non-regular files, oversized files, and
 * binary content are rejected before any decoding happens.
 */
export type FileKind =
  | { kind: "ok"; size: number }
  | { kind: "directory" }
  | { kind: "not_file" }
  | { kind: "too_large"; size: number };

export async function checkFileKind(
  filePath: string,
  label: string,
): Promise<FileKind> {
  const info = await stat(filePath);
  if (info.isDirectory()) {
    return { kind: "directory" };
  }
  if (!info.isFile()) {
    return { kind: "not_file" };
  }
  if (info.size > MAX_BYTES) {
    return { kind: "too_large", size: info.size };
  }
  return { kind: "ok", size: info.size };
}

export function assertFileKind(kind: FileKind, label: string): void {
  if (kind.kind === "directory") {
    throw new Error(
      `[E_BAD_REF] ${label} is a directory, not a file. Use glob() to list entries or grep() to search directory contents.`,
    );
  }
  if (kind.kind === "not_file") {
    throw new Error(`[E_BAD_REF] ${label} is not a regular file.`);
  }
  if (kind.kind === "too_large") {
    throw new Error(
      `[E_FILE_TOO_LARGE] ${label} is ${formatSize(kind.size)}, exceeding the ${formatSize(MAX_BYTES)} edit limit. Use write or a non-line-based approach for very large files.`,
    );
  }
}

export function assertLineCount(lineCount: number, label: string): void {
  if (lineCount > MAX_LINES) {
    throw new Error(
      `[E_FILE_TOO_LARGE] ${label} has ${lineCount} lines, exceeding the ${MAX_LINES}-line edit limit.`,
    );
  }
}
