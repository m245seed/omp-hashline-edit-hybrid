/**
 * Startup crash recovery (spec §31).
 *
 * For every unfinished transaction, compare the file's actual checksum:
 *
 * - file == before checksum: the file commit never happened → discard the
 *   pending post-state; keep the before snapshot (it is already stored).
 * - file == after checksum: the file commit happened but DB finalization did
 *   not → promote the stored after-state and create/finalize the undo entry.
 * - file matches neither: an external modification occurred → never guess;
 *   invalidate served state, reconcile anchors from the actual file on next
 *   read, drop transaction-specific undo, and log a divergence warning.
 */

import { lstat, readFile } from "fs/promises";
import { sha256Hex } from "../utils";
import { withTransaction } from "./database";
import {
  putSnapshotInTransaction,
  upsertUndoRow,
  deleteSnapshotInTransaction,
  type FileSnapshot,
  type UndoPayload,
} from "./snapshots";
import { deleteUndoRecordInTransaction } from "./undo";
import {
  deletePendingTransactionInTransaction,
  listPendingTransactions,
} from "./transaction-journal";

export interface RecoverySummary {
  discarded: number;
  promoted: number;
  diverged: number;
  warnings: string[];
}

export async function runRecovery(): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    discarded: 0,
    promoted: 0,
    diverged: 0,
    warnings: [],
  };
  const pending = listPendingTransactions();
  if (pending.length === 0) return summary;

  for (const entry of pending) {
    let raw: Buffer;
    try {
      const info = await lstat(entry.path);
      if (!info.isFile()) {
        const error = new Error("not a regular file") as NodeJS.ErrnoException;
        error.code = "ENOTFILE";
        throw error;
      }
      raw = await readFile(entry.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        code === "ENOTFILE" ||
        code === "EISDIR" ||
        code === "ENOTDIR"
      ) {
        // File deleted or replaced by a non-file mid-transaction: external
        // action. Do not guess.
        withTransaction(() => {
          deletePendingTransactionInTransaction(entry.transactionId);
          deleteUndoRecordInTransaction(entry.path);
          deleteSnapshotInTransaction(entry.path);
        });
        summary.diverged++;
        summary.warnings.push(
          `[W_STATE_RECOVERED] Pending transaction ${entry.transactionId} for ${entry.path} was discarded because the target was deleted or is no longer a regular file; anchors were invalidated.`,
        );
        continue;
      }
      // Unreadable for another reason: keep the pending row, log, and
      // continue — recovery is retried on the next startup.
      summary.warnings.push(
        `[W_STATE_RECOVERED] Could not inspect ${entry.path} for pending transaction ${entry.transactionId}: ${error instanceof Error ? error.message : String(error)}. Recovery deferred.`,
      );
      continue;
    }

    const checksum = sha256Hex(raw);
    if (checksum === entry.beforeChecksum) {
      // Commit never happened. The stored before-state is already the
      // authoritative snapshot; drop the pending post-state.
      withTransaction(() => {
        deletePendingTransactionInTransaction(entry.transactionId);
      });
      summary.discarded++;
      continue;
    }
    if (checksum === entry.afterChecksum) {
      // File committed; DB finalization did not. Promote the after-state
      // and create the undo entry.
      withTransaction(() => {
        const snapshot: FileSnapshot = {
          path: entry.path,
          rawChecksum: entry.afterChecksum,
          lineCount: entry.after.lineCount,
          anchors: entry.after.anchors,
          fingerprints: entry.after.fingerprints,
          retired: entry.after.retired,
          updatedAt: Date.now(),
        };
        putSnapshotInTransaction(snapshot);
        if (entry.undo) {
          const payload: UndoPayload = {
            path: entry.path,
            transactionId: entry.transactionId,
            beforeBytes: entry.undo.beforeBytes,
            afterChecksum: entry.undo.afterChecksum,
            beforeAnchors: entry.undo.beforeAnchors,
            beforeFingerprints: entry.undo.beforeFingerprints,
            beforeRetired: entry.undo.beforeRetired,
            afterAnchors: entry.after.anchors,
            afterFingerprints: entry.after.fingerprints,
            afterRetired: entry.after.retired,
          };
          upsertUndoRow(payload);
        } else {
          deleteUndoRecordInTransaction(entry.path);
        }
        deletePendingTransactionInTransaction(entry.transactionId);
      });
      summary.promoted++;
      summary.warnings.push(
        `[W_STATE_RECOVERED] Pending transaction ${entry.transactionId} for ${entry.path} was finalized after a crash (file commit detected).`,
      );
      continue;
    }

    // External modification: do not guess. Discard transaction state;
    // anchors will be reconciled from the actual file on the next read.
    withTransaction(() => {
      deletePendingTransactionInTransaction(entry.transactionId);
      deleteUndoRecordInTransaction(entry.path);
      deleteSnapshotInTransaction(entry.path);
    });
    summary.diverged++;
    summary.warnings.push(
      `[W_STATE_RECOVERED] Pending transaction ${entry.transactionId} for ${entry.path} diverged from both before and after checksums (external modification). Transaction state discarded; anchors will be reconciled from disk.`,
    );
  }
  return summary;
}
