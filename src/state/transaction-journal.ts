/**
 * Crash-recovery journal (spec §29 Phase 3, §31).
 *
 * Filesystem mutation and the SQLite commit cannot form a single truly
 * atomic transaction, so every mutation first persists a
 * `pending_transactions` row containing enough information to recover both
 * the pre- and post-state. Startup recovery then decides, from the file's
 * actual checksum, whether the commit never happened, happened but was not
 * finalized, or collided with an external writer.
 */

import { randomUUID } from "crypto";
import { cachedPrepare, withBusyRetry } from "./database";
import {
  decodeAnchorsBlob,
  decodeFingerprintsBlob,
  decodeRetiredBlob,
  encodeAnchorsBlob,
  encodeFingerprintsBlob,
  encodeRetiredBlob,
} from "./snapshots";

export interface PendingState {
  anchors: string[];
  fingerprints: string[];
  retired: Set<string>;
  lineCount: number;
}

export interface PendingTransaction {
  transactionId: string;
  path: string;
  beforeChecksum: string;
  afterChecksum: string;
  before: PendingState;
  after: PendingState;
  /** Undo payload to create on promotion (null when the mutation was itself an undo). */
  undo: {
    beforeBytes: Buffer;
    afterChecksum: string;
    beforeAnchors: string[];
    beforeFingerprints: string[];
    beforeRetired: Set<string>;
  } | null;
  createdAt: number;
}

interface PendingRow {
  transaction_id: string;
  path: string;
  before_checksum: string;
  after_checksum: string;
  before_anchors: Uint8Array;
  before_fingerprints: Uint8Array;
  before_retired: Uint8Array;
  before_line_count: number;
  after_anchors: Uint8Array;
  after_fingerprints: Uint8Array;
  after_retired: Uint8Array;
  after_line_count: number;
  undo_before_bytes: Uint8Array | null;
  undo_after_checksum: string | null;
  undo_before_anchors: Uint8Array | null;
  undo_before_fingerprints: Uint8Array | null;
  undo_before_retired: Uint8Array | null;
  created_at: number;
}

function encodeState(state: PendingState): {
  anchors: Buffer;
  fingerprints: Buffer;
  retired: Buffer;
} {
  return {
    anchors: encodeAnchorsBlob(state.anchors),
    fingerprints: encodeFingerprintsBlob(state.fingerprints),
    retired: encodeRetiredBlob(state.retired),
  };
}

function decodeState(
  row: PendingRow,
  prefix: "before" | "after",
): PendingState {
  const anchors = row[`${prefix}_anchors`];
  const fingerprints = row[`${prefix}_fingerprints`];
  const retired = row[`${prefix}_retired`];
  const lineCount = row[`${prefix}_line_count`];
  const decodedAnchors = decodeAnchorsBlob(anchors, lineCount);
  const decodedRetired = decodeRetiredBlob(retired);
  for (const anchor of decodedAnchors) {
    if (decodedRetired.has(anchor)) {
      throw new Error(
        `Corrupt pending transaction: ${prefix} anchor is retired`,
      );
    }
  }
  return {
    anchors: decodedAnchors,
    fingerprints: decodeFingerprintsBlob(fingerprints, lineCount),
    retired: decodedRetired,
    lineCount,
  };
}

export function newTransactionId(): string {
  return randomUUID();
}

export function insertPendingTransaction(entry: PendingTransaction): void {
  const before = encodeState(entry.before);
  const after = encodeState(entry.after);
  withBusyRetry(() =>
    cachedPrepare(
      `INSERT INTO pending_transactions (
           transaction_id, path, before_checksum, after_checksum,
           before_anchors, before_fingerprints, before_retired, before_line_count,
           after_anchors, after_fingerprints, after_retired, after_line_count,
           undo_before_bytes, undo_after_checksum,
           undo_before_anchors, undo_before_fingerprints, undo_before_retired,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.transactionId,
      entry.path,
      entry.beforeChecksum,
      entry.afterChecksum,
      before.anchors,
      before.fingerprints,
      before.retired,
      entry.before.lineCount,
      after.anchors,
      after.fingerprints,
      after.retired,
      entry.after.lineCount,
      entry.undo?.beforeBytes ?? null,
      entry.undo?.afterChecksum ?? null,
      entry.undo ? encodeAnchorsBlob(entry.undo.beforeAnchors) : null,
      entry.undo ? encodeFingerprintsBlob(entry.undo.beforeFingerprints) : null,
      entry.undo ? encodeRetiredBlob(entry.undo.beforeRetired) : null,
      entry.createdAt,
    ),
  );
}

export function listPendingTransactions(): PendingTransaction[] {
  const rows = cachedPrepare(
    `SELECT * FROM pending_transactions ORDER BY created_at`,
  ).all() as unknown as PendingRow[];
  return rows.map((row) => {
    const undoFields = [
      row.undo_before_bytes,
      row.undo_after_checksum,
      row.undo_before_anchors,
      row.undo_before_fingerprints,
      row.undo_before_retired,
    ];
    const hasUndoField = undoFields.some((field) => field !== null);
    const hasCompleteUndo = undoFields.every((field) => field !== null);
    if (hasUndoField && !hasCompleteUndo) {
      throw new Error("Corrupt pending transaction: incomplete undo payload");
    }
    const undo = hasCompleteUndo
      ? (() => {
          const lineCount = row.undo_before_anchors!.length / 4;
          const beforeAnchors = decodeAnchorsBlob(
            row.undo_before_anchors!,
            lineCount,
          );
          const beforeRetired = decodeRetiredBlob(row.undo_before_retired!);
          if (beforeAnchors.some((anchor) => beforeRetired.has(anchor))) {
            throw new Error(
              "Corrupt pending transaction: undo anchor is retired",
            );
          }
          return {
            beforeBytes: Buffer.from(row.undo_before_bytes!),
            afterChecksum: row.undo_after_checksum!,
            beforeAnchors,
            beforeFingerprints: decodeFingerprintsBlob(
              row.undo_before_fingerprints!,
              lineCount,
            ),
            beforeRetired,
          };
        })()
      : null;
    return {
      transactionId: row.transaction_id,
      path: row.path,
      beforeChecksum: row.before_checksum,
      afterChecksum: row.after_checksum,
      before: decodeState(row, "before"),
      after: decodeState(row, "after"),
      undo,
      createdAt: row.created_at,
    };
  });
}

export function deletePendingTransaction(transactionId: string): void {
  withBusyRetry(() =>
    cachedPrepare(
      `DELETE FROM pending_transactions WHERE transaction_id = ?`,
    ).run(transactionId),
  );
}

/** Use only inside an existing withTransaction callback. */
export function deletePendingTransactionInTransaction(
  transactionId: string,
): void {
  cachedPrepare(
    `DELETE FROM pending_transactions WHERE transaction_id = ?`,
  ).run(transactionId);
}
