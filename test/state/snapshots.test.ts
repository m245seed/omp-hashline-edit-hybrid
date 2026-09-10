import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";

import { resetStoreForTests, loadStore } from "../../src/state/database";
import {
  encodeAnchorsBlob,
  decodeAnchorsBlob,
  encodeFingerprintsBlob,
  decodeFingerprintsBlob,
  encodeRetiredBlob,
  decodeRetiredBlob,
  getSnapshot,
  putSnapshot,
  finalizeTransaction,
  type FileSnapshot,
} from "../../src/state/snapshots";
import {
  insertPendingTransaction,
  listPendingTransactions,
  deletePendingTransaction,
  newTransactionId,
  type PendingTransaction,
} from "../../src/state/transaction-journal";
import {
  getUndoRecord,
  deleteUndoRecord,
  loadUndoRecord,
  clearUndoRecord,
} from "../../src/state/undo";

beforeEach(() => {
  withStateDir();
});

afterEach(async () => {
  await resetStoreForTests();
});

function snapshot(path: string, texts: string[]): FileSnapshot {
  return {
    path,
    rawChecksum: "a".repeat(64),
    lineCount: texts.length,
    anchors: texts.map((_, i) => `A${String(i).padStart(3, "0")}`),
    fingerprints: texts.map((_, i) => `f${String(i).padStart(63, "0")}`),
    retired: new Set(["Z000", "Z001"]),
    updatedAt: 1,
  };
}

describe("blob codecs (spec §65)", () => {
  it("round-trips anchors", () => {
    const anchors = ["A000", "B001", "C002", "zZz9"];
    expect(
      decodeAnchorsBlob(encodeAnchorsBlob(anchors), anchors.length),
    ).toEqual(anchors);
  });

  it("rejects corrupt anchor blobs", () => {
    expect(() => decodeAnchorsBlob(Buffer.from("A000B001"), 2)).not.toThrow();
    expect(() => decodeAnchorsBlob(Buffer.from("A000B00"), 2)).toThrow(
      /Corrupt/,
    );
    expect(() => decodeAnchorsBlob(Buffer.from("A000!001"), 2)).toThrow(
      /Corrupt/,
    );
    expect(() => decodeAnchorsBlob(Buffer.from("A000A000"), 2)).toThrow(
      /duplicate/,
    );
  });

  it("round-trips fingerprints", () => {
    const fps = ["a".repeat(64), "b".repeat(64)];
    expect(decodeFingerprintsBlob(encodeFingerprintsBlob(fps), 2)).toEqual(fps);
  });

  it("rejects corrupt fingerprint blobs", () => {
    expect(() => decodeFingerprintsBlob(Buffer.alloc(10), 1)).toThrow(
      /Corrupt/,
    );
    expect(() => encodeFingerprintsBlob(["x".repeat(64)])).toThrow(
      /invalid fingerprint/,
    );
    expect(() => decodeFingerprintsBlob(Buffer.alloc(32), 0.5)).toThrow(
      /Corrupt/,
    );
  });

  it("round-trips retired sets", () => {
    const retired = new Set(["Z000", "A999", "B001"]);
    expect(decodeRetiredBlob(encodeRetiredBlob(retired))).toEqual(
      new Set(["Z000", "A999", "B001"]),
    );
    expect(decodeRetiredBlob(Buffer.alloc(0))).toEqual(new Set());
  });

  it("rejects corrupt retired blobs", () => {
    expect(() => decodeRetiredBlob(Buffer.alloc(4))).toThrow(/Corrupt/);
    expect(() => decodeRetiredBlob(Buffer.alloc(6))).toThrow(/duplicate/);
    expect(() => decodeRetiredBlob(Buffer.from([0xff, 0xff, 0xff]))).toThrow(
      /out of range/,
    );
  });
});

describe("snapshot store", () => {
  it("persists and loads a snapshot", async () => {
    await loadStore();
    putSnapshot("/p/a.ts", snapshot("/p/a.ts", ["one", "two"]));
    const loaded = getSnapshot("/p/a.ts");
    expect(loaded?.anchors).toEqual(["A000", "A001"]);
    expect(loaded?.retired).toEqual(new Set(["Z000", "Z001"]));
    expect(loaded?.rawChecksum).toBe("a".repeat(64));
  });

  it("returns undefined for unknown paths", async () => {
    await loadStore();
    expect(getSnapshot("/p/nope.ts")).toBeUndefined();
  });

  it("drops a corrupt row and self-heals instead of failing forever", async () => {
    const store = await loadStore();
    putSnapshot("/p/good.ts", snapshot("/p/good.ts", ["one"]));
    // Corrupt the anchors blob so it no longer decodes against line_count.
    store.db
      .prepare(`UPDATE files SET anchors = ? WHERE path = ?`)
      .run(Buffer.from("A00"), "/p/good.ts");
    expect(getSnapshot("/p/good.ts")).toBeUndefined();
    // The corrupt row was removed; a fresh snapshot can be written again.
    const row = store.db
      .prepare(`SELECT COUNT(*) AS n FROM files WHERE path = ?`)
      .get("/p/good.ts") as { n: number };
    expect(row.n).toBe(0);
    putSnapshot("/p/good.ts", snapshot("/p/good.ts", ["one"]));
    expect(getSnapshot("/p/good.ts")?.anchors).toEqual(["A000"]);
  });
});

describe("transaction journal", () => {
  function pending(path: string, transactionId: string): PendingTransaction {
    return {
      transactionId,
      path,
      beforeChecksum: "b".repeat(64),
      afterChecksum: "c".repeat(64),
      before: {
        anchors: ["A000"],
        fingerprints: ["f0".padEnd(64, "0")],
        retired: new Set(),
        lineCount: 1,
      },
      after: {
        anchors: ["A000", "B001"],
        fingerprints: ["f0".padEnd(64, "0"), "f1".padEnd(64, "0")],
        retired: new Set(),
        lineCount: 2,
      },
      undo: {
        beforeBytes: Buffer.from("one\n", "utf-8"),
        afterChecksum: "c".repeat(64),
        beforeAnchors: ["A000"],
        beforeFingerprints: ["f0".padEnd(64, "0")],
        beforeRetired: new Set(),
      },
      createdAt: 1,
    };
  }

  it("inserts, lists, and deletes pending transactions", async () => {
    await loadStore();
    const id = newTransactionId();
    insertPendingTransaction(pending("/p/a.ts", id));
    const listed = listPendingTransactions();
    expect(listed.length).toBe(1);
    expect(listed[0]!.transactionId).toBe(id);
    expect(listed[0]!.before.anchors).toEqual(["A000"]);
    expect(listed[0]!.after.anchors).toEqual(["A000", "B001"]);
    expect(listed[0]!.undo?.beforeBytes.toString()).toBe("one\n");
    deletePendingTransaction(id);
    expect(listPendingTransactions().length).toBe(0);
  });

  it("supports undo-less pending records (undo operations)", async () => {
    await loadStore();
    const entry = pending("/p/a.ts", newTransactionId());
    entry.undo = null;
    insertPendingTransaction(entry);
    const listed = listPendingTransactions();
    expect(listed[0]!.undo).toBeNull();
  });
});

describe("finalizeTransaction", () => {
  it("atomically writes snapshot + undo and clears the journal", async () => {
    await loadStore();
    const id = newTransactionId();
    const snap = snapshot("/p/a.ts", ["one", "two", "three"]);
    insertPendingTransaction({
      transactionId: id,
      path: "/p/a.ts",
      beforeChecksum: "b".repeat(64),
      afterChecksum: snap.rawChecksum,
      before: {
        anchors: ["A000"],
        fingerprints: ["f0".repeat(32)],
        retired: new Set(),
        lineCount: 1,
      },
      after: {
        anchors: snap.anchors,
        fingerprints: snap.fingerprints,
        retired: snap.retired,
        lineCount: 3,
      },
      undo: {
        beforeBytes: Buffer.from("one\n", "utf-8"),
        afterChecksum: snap.rawChecksum,
        beforeAnchors: ["A000"],
        beforeFingerprints: ["f0".repeat(32)],
        beforeRetired: new Set(),
      },
      createdAt: 1,
    });

    finalizeTransaction({
      snapshot: snap,
      undoPayload: {
        path: "/p/a.ts",
        transactionId: id,
        beforeBytes: Buffer.from("one\n", "utf-8"),
        afterChecksum: snap.rawChecksum,
        beforeAnchors: ["A000"],
        beforeFingerprints: ["f0".repeat(32)],
        beforeRetired: new Set(),
        afterAnchors: snap.anchors,
        afterFingerprints: snap.fingerprints,
        afterRetired: snap.retired,
      },
      pendingTransactionId: id,
    });

    expect(listPendingTransactions().length).toBe(0);
    expect(getSnapshot("/p/a.ts")?.anchors).toEqual(snap.anchors);
    const undo = getUndoRecord("/p/a.ts");
    expect(undo?.beforeBytes.toString()).toBe("one\n");
    expect(undo?.afterAnchors).toEqual(snap.anchors);
  });

  it("clears undo when no undo payload is supplied", async () => {
    await loadStore();
    const snap = snapshot("/p/a.ts", ["one"]);
    finalizeTransaction({
      snapshot: snap,
      undoPayload: null,
      pendingTransactionId: "nope",
    });
    expect(getUndoRecord("/p/a.ts")).toBeUndefined();
    deleteUndoRecord("/p/a.ts");
    // A second finalize with payload now creates the record.
    finalizeTransaction({
      snapshot: snap,
      undoPayload: {
        path: "/p/a.ts",
        transactionId: "t2",
        beforeBytes: Buffer.from("", "utf-8"),
        afterChecksum: snap.rawChecksum,
        beforeAnchors: [],
        beforeFingerprints: [],
        beforeRetired: new Set(),
        afterAnchors: snap.anchors,
        afterFingerprints: snap.fingerprints,
        afterRetired: snap.retired,
      },
      pendingTransactionId: "nope",
    });
    expect(getUndoRecord("/p/a.ts")?.transactionId).toBe("t2");
  });
});

describe("undo record helpers", () => {
  it("loads and clears undo records by path", async () => {
    await loadStore();
    const snap = snapshot("/p/u.ts", ["one"]);
    finalizeTransaction({
      snapshot: snap,
      undoPayload: {
        path: "/p/u.ts",
        transactionId: "u1",
        beforeBytes: Buffer.from("", "utf-8"),
        afterChecksum: snap.rawChecksum,
        beforeAnchors: [],
        beforeFingerprints: [],
        beforeRetired: new Set(),
        afterAnchors: snap.anchors,
        afterFingerprints: snap.fingerprints,
        afterRetired: snap.retired,
      },
      pendingTransactionId: "nope",
    });
    const record = await loadUndoRecord("/p/u.ts");
    expect(record?.transactionId).toBe("u1");
    await clearUndoRecord("/p/u.ts");
    expect(await loadUndoRecord("/p/u.ts")).toBeUndefined();
  });
});
