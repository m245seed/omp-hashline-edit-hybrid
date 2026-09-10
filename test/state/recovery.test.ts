import { writeFile, mkdir, symlink } from "fs/promises";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, withStateDir } from "../support/env";

import { sha256Hex } from "../../src/utils";
import {
  resetStoreForTests,
  loadStore,
  requireStore,
} from "../../src/state/database";
import { runRecovery } from "../../src/state/recovery";
import {
  insertPendingTransaction,
  newTransactionId,
  type PendingTransaction,
} from "../../src/state/transaction-journal";
import { getSnapshot } from "../../src/state/snapshots";
import { getUndoRecord } from "../../src/state/undo";

beforeEach(() => {
  withStateDir();
});

afterEach(async () => {
  await resetStoreForTests();
});

function pendingFor(
  path: string,
  beforeHex: string,
  afterHex: string,
  transactionId: string,
): PendingTransaction {
  return {
    transactionId,
    path,
    beforeChecksum: beforeHex,
    afterChecksum: afterHex,
    before: {
      anchors: ["A000", "A001"],
      fingerprints: ["b0".padEnd(64, "0"), "b1".padEnd(64, "0")],
      retired: new Set(),
      lineCount: 2,
    },
    after: {
      anchors: ["A000", "C002"],
      fingerprints: ["b0".padEnd(64, "0"), "c2".padEnd(64, "0")],
      retired: new Set(["A001"]),
      lineCount: 2,
    },
    undo: {
      beforeBytes: Buffer.from("one\ntwo\n", "utf-8"),
      afterChecksum: afterHex,
      beforeAnchors: ["A000", "A001"],
      beforeFingerprints: ["b0".padEnd(64, "0"), "b1".padEnd(64, "0")],
      beforeRetired: new Set(),
    },
    createdAt: 1,
  };
}

describe("crash recovery (spec §31)", () => {
  it("discards pending state when the file still matches the before checksum", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "a.ts");
    const beforeHex = sha256Hex(Buffer.from("one\ntwo\n", "utf-8"));
    await writeFile(path, "one\ntwo\n", "utf-8");
    await loadStore();
    insertPendingTransaction(
      pendingFor(path, beforeHex, "c".repeat(64), newTransactionId()),
    );

    const summary = await runRecovery();
    expect(summary.discarded).toBe(1);
    expect(summary.promoted).toBe(0);
    expect(
      requireStore()
        .db.prepare("SELECT COUNT(*) AS n FROM pending_transactions")
        .get()!.n,
    ).toBe(0);
  });

  it("promotes the after-state when the file matches the after checksum", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "a.ts");
    const afterHex = sha256Hex(Buffer.from("one\nTHREE\n", "utf-8"));
    await writeFile(path, "one\nTHREE\n", "utf-8");
    await loadStore();
    const id = newTransactionId();
    insertPendingTransaction(pendingFor(path, "b".repeat(64), afterHex, id));

    const summary = await runRecovery();
    expect(summary.promoted).toBe(1);
    const snap = getSnapshot(path);
    expect(snap?.rawChecksum).toBe(afterHex);
    expect(snap?.anchors).toEqual(["A000", "C002"]);
    expect(snap?.retired).toEqual(new Set(["A001"]));
    // Undo entry is created from the journal payload.
    const undo = getUndoRecord(path);
    expect(undo?.beforeBytes.toString()).toBe("one\ntwo\n");
    expect(undo?.afterChecksum).toBe(afterHex);
    expect(
      requireStore()
        .db.prepare("SELECT COUNT(*) AS n FROM pending_transactions")
        .get()!.n,
    ).toBe(0);
  });

  it("diverges on external modification and never guesses", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "a.ts");
    await writeFile(path, "COMPLETELY DIFFERENT\n", "utf-8");
    await loadStore();
    insertPendingTransaction(
      pendingFor(path, "b".repeat(64), "c".repeat(64), newTransactionId()),
    );

    const summary = await runRecovery();
    expect(summary.diverged).toBe(1);
    expect(summary.warnings.some((w) => w.includes("W_STATE_RECOVERED"))).toBe(
      true,
    );
    expect(
      requireStore()
        .db.prepare("SELECT COUNT(*) AS n FROM pending_transactions")
        .get()!.n,
    ).toBe(0);
    expect(getUndoRecord(path)).toBeUndefined();
  });

  it("handles a deleted file as divergence", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "gone.ts");
    await mkdir(dir, { recursive: true });
    await loadStore();
    insertPendingTransaction(
      pendingFor(path, "b".repeat(64), "c".repeat(64), newTransactionId()),
    );
    const summary = await runRecovery();
    expect(summary.diverged).toBe(1);
  });

  it("handles a target replaced by a directory as divergence", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "replaced.ts");
    await mkdir(path, { recursive: true });
    await loadStore();
    insertPendingTransaction(
      pendingFor(path, "b".repeat(64), "c".repeat(64), newTransactionId()),
    );
    const summary = await runRecovery();
    expect(summary.diverged).toBe(1);
    expect(
      requireStore()
        .db.prepare("SELECT COUNT(*) AS n FROM pending_transactions")
        .get()!.n,
    ).toBe(0);
  });

  it("handles a target replaced by a symlink as divergence", async () => {
    const dir = makeTmpDir("rec-");
    const path = join(dir, "linked.ts");
    const target = join(dir, "actual.ts");
    const afterHex = sha256Hex(Buffer.from("one\nTHREE\n", "utf-8"));
    await writeFile(target, "one\nTHREE\n", "utf-8");
    await symlink(target, path);
    await loadStore();
    insertPendingTransaction(
      pendingFor(path, "b".repeat(64), afterHex, newTransactionId()),
    );
    const summary = await runRecovery();
    expect(summary.diverged).toBe(1);
    expect(getSnapshot(path)).toBeUndefined();
  });

  it("does nothing when there are no pending transactions", async () => {
    await loadStore();
    const summary = await runRecovery();
    expect(summary.discarded).toBe(0);
    expect(summary.promoted).toBe(0);
    expect(summary.diverged).toBe(0);
  });
});
