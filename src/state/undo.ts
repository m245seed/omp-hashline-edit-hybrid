/**
 * Persistent undo records (spec §32–§36).
 *
 * One undo transaction per file, persisted across restarts. The record keeps
 * the exact previous raw bytes (byte fidelity, spec §34) plus the exact
 * before/after anchor states so undo is a true restoration of document
 * identity, not merely text (spec §35).
 */

import { cachedPrepare, loadStore, withBusyRetry } from "./database";
import {
  decodeAnchorsBlob,
  decodeFingerprintsBlob,
  decodeRetiredBlob,
} from "./snapshots";

interface UndoRow {
  path: string;
  transaction_id: string;
  before_bytes: Uint8Array;
  after_checksum: string;
  before_anchors: Uint8Array;
  before_fingerprints: Uint8Array;
  before_retired: Uint8Array;
  after_anchors: Uint8Array;
  after_fingerprints: Uint8Array;
  after_retired: Uint8Array;
}

export interface UndoRecord {
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

export function getUndoRecord(path: string): UndoRecord | undefined {
  const row = cachedPrepare(
    `SELECT path, transaction_id, before_bytes, after_checksum,
         before_anchors, before_fingerprints, before_retired,
         after_anchors, after_fingerprints, after_retired
       FROM undo WHERE path = ?`,
  ).get(path) as UndoRow | undefined;
  if (!row) return undefined;
  const beforeLineCount = row.before_anchors.length / 4;
  const afterLineCount = row.after_anchors.length / 4;
  const beforeAnchors = decodeAnchorsBlob(row.before_anchors, beforeLineCount);
  const afterAnchors = decodeAnchorsBlob(row.after_anchors, afterLineCount);
  const beforeRetired = decodeRetiredBlob(row.before_retired);
  const afterRetired = decodeRetiredBlob(row.after_retired);
  if (beforeAnchors.some((anchor) => beforeRetired.has(anchor))) {
    throw new Error("Corrupt undo record: before anchor is retired");
  }
  if (afterAnchors.some((anchor) => afterRetired.has(anchor))) {
    throw new Error("Corrupt undo record: after anchor is retired");
  }
  return {
    path: row.path,
    transactionId: row.transaction_id,
    beforeBytes: Buffer.from(row.before_bytes),
    afterChecksum: row.after_checksum,
    beforeAnchors,
    beforeFingerprints: decodeFingerprintsBlob(
      row.before_fingerprints,
      beforeLineCount,
    ),
    beforeRetired,
    afterAnchors,
    afterFingerprints: decodeFingerprintsBlob(
      row.after_fingerprints,
      afterLineCount,
    ),
    afterRetired,
  };
}

export function deleteUndoRecord(path: string): void {
  withBusyRetry(() =>
    cachedPrepare(`DELETE FROM undo WHERE path = ?`).run(path),
  );
}

/** Use only inside an existing withTransaction callback. */
export function deleteUndoRecordInTransaction(path: string): void {
  cachedPrepare(`DELETE FROM undo WHERE path = ?`).run(path);
}

export async function loadUndoRecord(
  path: string,
): Promise<UndoRecord | undefined> {
  await loadStore();
  return getUndoRecord(path);
}

export async function clearUndoRecord(path: string): Promise<void> {
  await loadStore();
  deleteUndoRecord(path);
}
