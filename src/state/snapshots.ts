/**
 * Per-file anchor snapshots (spec §50, §65).
 *
 * Compact binary representation: anchors as 4 ASCII bytes per line,
 * fingerprints as 32 SHA-256 bytes per line, retired anchors as a packed
 * sorted array of 3-byte base62 indexes. One SQLite row per file; writes
 * happen once per transaction, not once per line.
 */

import {
  ANCHOR_RE,
  ANCHOR_SPACE,
  anchorToIdx,
  idxToAnchor,
} from "../anchors/alphabet";
import {
  FINGERPRINT_BYTES,
  decodeFingerprintHexes,
} from "../anchors/fingerprints";
import { cachedPrepare, withBusyRetry, withTransaction } from "./database";

export interface FileSnapshot {
  path: string;
  rawChecksum: string;
  lineCount: number;
  anchors: string[];
  fingerprints: string[];
  retired: Set<string>;
  updatedAt: number;
}

export interface UndoPayload {
  path: string;
  transactionId: string;
  beforeBytes: Buffer;
  afterChecksum: string;
  beforeAnchors: string[];
  beforeFingerprints: string[];
  beforeRetired: Set<string>;
  afterAnchors: string[];
  afterFingerprints: string[];
  afterRetired: Set<string>;
}

// ─── Blob codecs ────────────────────────────────────────────────────────

export function encodeAnchorsBlob(anchors: string[]): Buffer {
  const out = Buffer.allocUnsafe(anchors.length * 4);
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    // 'ascii' writes silently drop high bytes and a short string would
    // leave uninitialized bytes; validate so corruption fails at the
    // producer instead of decoding as a plausible-but-wrong anchor.
    if (!ANCHOR_RE.test(anchor)) {
      throw new Error(
        `Corrupt anchors blob encode: invalid anchor ${JSON.stringify(anchor)}`,
      );
    }
    out.write(anchor, i * 4, 4, "ascii");
  }
  return out;
}

export function decodeAnchorsBlob(
  blob: Uint8Array,
  lineCount: number,
): string[] {
  if (
    !Number.isInteger(lineCount) ||
    lineCount < 0 ||
    blob.length !== lineCount * 4
  ) {
    throw new Error("Corrupt anchors blob: length mismatch");
  }
  const buf = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const anchors = new Array<string>(lineCount);
  const seen = new Set<string>();
  for (let i = 0; i < lineCount; i++) {
    const anchor = buf.toString("ascii", i * 4, i * 4 + 4);
    if (!ANCHOR_RE.test(anchor)) {
      throw new Error("Corrupt anchors blob: invalid anchor");
    }
    if (seen.has(anchor)) {
      throw new Error("Corrupt anchors blob: duplicate anchor");
    }
    seen.add(anchor);
    anchors[i] = anchor;
  }
  return anchors;
}

export function encodeFingerprintsBlob(fingerprints: string[]): Buffer {
  const out = Buffer.allocUnsafe(fingerprints.length * FINGERPRINT_BYTES);
  for (let i = 0; i < fingerprints.length; i++) {
    const fingerprint = fingerprints[i]!;
    if (!/^[0-9a-fA-F]{64}$/.test(fingerprint)) {
      throw new Error(
        `Corrupt fingerprints blob encode: invalid fingerprint ${JSON.stringify(fingerprint)}`,
      );
    }
    out.write(fingerprint, i * FINGERPRINT_BYTES, FINGERPRINT_BYTES, "hex");
  }
  return out;
}

export function decodeFingerprintsBlob(
  blob: Uint8Array,
  lineCount: number,
): string[] {
  if (
    !Number.isInteger(lineCount) ||
    lineCount < 0 ||
    blob.length !== lineCount * FINGERPRINT_BYTES
  ) {
    throw new Error("Corrupt fingerprints blob: length mismatch");
  }
  return decodeFingerprintHexes(blob);
}

export function encodeRetiredBlob(retired: ReadonlySet<string>): Buffer {
  const sorted = [...retired].sort();
  const out = Buffer.alloc(sorted.length * 3);
  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i]!;
    const idx = anchorToIdx(anchor);
    if (!ANCHOR_RE.test(anchor) || idx < 0 || idx >= ANCHOR_SPACE) {
      throw new Error("Invalid retired anchor");
    }
    out.writeUIntBE(idx, i * 3, 3);
  }
  return out;
}

export function decodeRetiredBlob(blob: Uint8Array): Set<string> {
  if (blob.length % 3 !== 0) {
    throw new Error("Corrupt retired blob: length mismatch");
  }
  const retired = new Set<string>();
  for (let i = 0; i < blob.length; i += 3) {
    const idx = (blob[i]! << 16) | (blob[i + 1]! << 8) | blob[i + 2]!;
    if (idx >= ANCHOR_SPACE) {
      throw new Error("Corrupt retired blob: anchor index out of range");
    }
    const anchor = idxToAnchor(idx);
    if (retired.has(anchor)) {
      throw new Error("Corrupt retired blob: duplicate anchor");
    }
    retired.add(anchor);
  }
  return retired;
}

// ─── Row mapping ────────────────────────────────────────────────────────

interface FilesRow {
  path: string;
  raw_checksum: string;
  line_count: number;
  anchor_epoch: number;
  anchors: Uint8Array;
  fingerprints: Uint8Array;
  retired: Uint8Array;
  updated_at: number;
}

function rowToSnapshot(row: FilesRow): FileSnapshot {
  const lineCount = row.line_count;
  const anchors = decodeAnchorsBlob(row.anchors, lineCount);
  const fingerprints = decodeFingerprintsBlob(row.fingerprints, lineCount);
  const retired = decodeRetiredBlob(row.retired);
  for (const anchor of anchors) {
    if (retired.has(anchor)) {
      throw new Error("Corrupt snapshot: active anchor is retired");
    }
  }
  return {
    path: row.path,
    rawChecksum: row.raw_checksum,
    lineCount,
    anchors,
    fingerprints,
    retired,
    updatedAt: row.updated_at,
  };
}

// ─── Store operations ───────────────────────────────────────────────────

/**
 * Load the snapshot for a path. A row whose blobs no longer decode (partial
 * corruption) is dropped and rebuilt from disk on the next anchored read,
 * instead of permanently breaking that file.
 */
export function getSnapshot(path: string): FileSnapshot | undefined {
  const row = cachedPrepare(
    `SELECT path, raw_checksum, line_count, anchor_epoch, anchors, fingerprints, retired, updated_at FROM files WHERE path = ?`,
  ).get(path) as FilesRow | undefined;
  if (!row) return undefined;
  try {
    return rowToSnapshot(row);
  } catch (error) {
    console.error(
      `Hashline snapshot for ${path} is corrupt; rebuilding from disk:`,
      error,
    );
    try {
      withBusyRetry(() =>
        cachedPrepare(`DELETE FROM files WHERE path = ?`).run(path),
      );
    } catch {}
    return undefined;
  }
}

function upsertSnapshotRow(snapshot: FileSnapshot): void {
  cachedPrepare(
    `INSERT INTO files (path, raw_checksum, line_count, anchor_epoch, anchors, fingerprints, retired, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         raw_checksum = excluded.raw_checksum,
         line_count = excluded.line_count,
         anchor_epoch = excluded.anchor_epoch,
         anchors = excluded.anchors,
         fingerprints = excluded.fingerprints,
         retired = excluded.retired,
         updated_at = excluded.updated_at`,
  ).run(
    snapshot.path,
    snapshot.rawChecksum,
    snapshot.lineCount,
    1,
    encodeAnchorsBlob(snapshot.anchors),
    encodeFingerprintsBlob(snapshot.fingerprints),
    encodeRetiredBlob(snapshot.retired),
    snapshot.updatedAt,
  );
}

export function putSnapshot(path: string, snapshot: FileSnapshot): void {
  if (snapshot.path !== path) {
    throw new Error("Snapshot path does not match persistence key");
  }
  withBusyRetry(() => upsertSnapshotRow(snapshot));
}

/** Use only inside an existing withTransaction callback. */
export function putSnapshotInTransaction(snapshot: FileSnapshot): void {
  upsertSnapshotRow(snapshot);
}

export function deleteSnapshot(path: string): void {
  withBusyRetry(() =>
    cachedPrepare(`DELETE FROM files WHERE path = ?`).run(path),
  );
}

/** Use only inside an existing withTransaction callback. */
export function deleteSnapshotInTransaction(path: string): void {
  cachedPrepare(`DELETE FROM files WHERE path = ?`).run(path);
}

/**
 * Finalize a committed transaction (spec §29 Phase 7): atomically update the
 * anchor snapshot, the undo record, and clear the pending journal row.
 * Uses raw statements inside the transaction — inner busy-retry is handled
 * by the outer withTransaction, not per-statement, to avoid retry-within-
 * transaction lock loss.
 */
export function finalizeTransaction(opts: {
  snapshot: FileSnapshot;
  undoPayload: UndoPayload | null;
  pendingTransactionId: string;
}): void {
  withTransaction(() => {
    putSnapshotInTransaction(opts.snapshot);
    if (opts.undoPayload) {
      upsertUndoRow(opts.undoPayload);
    } else {
      cachedPrepare(`DELETE FROM undo WHERE path = ?`).run(opts.snapshot.path);
    }
    cachedPrepare(
      `DELETE FROM pending_transactions WHERE transaction_id = ?`,
    ).run(opts.pendingTransactionId);
  });
}

export function upsertUndoRow(payload: UndoPayload): void {
  cachedPrepare(
    `INSERT INTO undo (path, transaction_id, before_bytes, after_checksum,
         before_anchors, before_fingerprints, before_retired,
         after_anchors, after_fingerprints, after_retired, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         transaction_id = excluded.transaction_id,
         before_bytes = excluded.before_bytes,
         after_checksum = excluded.after_checksum,
         before_anchors = excluded.before_anchors,
         before_fingerprints = excluded.before_fingerprints,
         before_retired = excluded.before_retired,
         after_anchors = excluded.after_anchors,
         after_fingerprints = excluded.after_fingerprints,
         after_retired = excluded.after_retired,
         created_at = excluded.created_at`,
  ).run(
    payload.path,
    payload.transactionId,
    payload.beforeBytes,
    payload.afterChecksum,
    encodeAnchorsBlob(payload.beforeAnchors),
    encodeFingerprintsBlob(payload.beforeFingerprints),
    encodeRetiredBlob(payload.beforeRetired),
    encodeAnchorsBlob(payload.afterAnchors),
    encodeFingerprintsBlob(payload.afterFingerprints),
    encodeRetiredBlob(payload.afterRetired),
    Date.now(),
  );
}
