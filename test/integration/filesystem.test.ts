import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import {
  makeProject,
  runTool,
  textOf,
  writeFileAt,
  readFileAt,
  anchorsFromRead,
} from "../support/tools";

import { resetStoreForTests, loadStore } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import {
  loadAnchoredFile,
  commitMutation,
} from "../../src/mutation/transaction";
import { newTransactionId } from "../../src/state/transaction-journal";
import { decodeDocument, encodeDocument } from "../../src/document/encoding";
import { fingerprintHexes } from "../../src/anchors/fingerprints";
import { applyTransaction } from "../../src/mutation/apply";
import { sha256Hex } from "../../src/utils";
import {
  clearSweptDirsForTests,
  writeInPlace,
  precommitVerify,
} from "../../src/filesystem/atomic-write";
import { join } from "path";
import {
  linkSync,
  symlinkSync,
  statSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "fs";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  clearSweptDirsForTests();
  await resetStoreForTests();
});

describe("filesystem behaviors (spec §43–§46)", () => {
  it("edits through a symlink preserve the symlink and change the target", async () => {
    const dir = makeProject();
    writeFileAt(dir, "real.ts", "one\ntwo\n");
    symlinkSync(join(dir, "real.ts"), join(dir, "link.ts"));
    const read = await runTool(readTool, { path: "link.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    const result = await runTool(
      editTool,
      { path: "link.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readlinkSync(join(dir, "link.ts"))).toBe(join(dir, "real.ts"));
    expect(readFileAt(join(dir, "real.ts"))).toBe("ONE\ntwo\n");
  });

  it("edits a chained symlink to the real target", async () => {
    const dir = makeProject();
    writeFileAt(dir, "real.ts", "one\ntwo\n");
    symlinkSync(join(dir, "real.ts"), join(dir, "mid.ts"));
    symlinkSync(join(dir, "mid.ts"), join(dir, "outer.ts"));
    const read = await runTool(readTool, { path: "outer.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const two = anchors.get("two")!;
    const result = await runTool(
      editTool,
      { path: "outer.ts", edits: [{ range: [two, two], lines: ["TWO"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "real.ts"))).toBe("one\nTWO\n");
  });

  it("detects symlink loops as ELOOP", async () => {
    const dir = makeProject();
    symlinkSync(join(dir, "a.ts"), join(dir, "b.ts"));
    symlinkSync(join(dir, "b.ts"), join(dir, "a.ts"));
    await expect(runTool(readTool, { path: "a.ts" }, dir)).rejects.toThrow(
      /ELOOP|Too many symbolic links/,
    );
  });

  it("preserves hard links by writing in place with a warning", async () => {
    const dir = makeProject();
    const p1 = join(dir, "h1.ts");
    const p2 = join(dir, "h2.ts");
    require("fs").writeFileSync(p1, "one\ntwo\n", "utf-8");
    linkSync(p1, p2);
    expect(statSync(p1).nlink).toBe(2);

    const read = await runTool(readTool, { path: "h1.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    const result = await runTool(
      editTool,
      { path: "h1.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    // Both names share the same inode, so both reflect the change.
    expect(readFileAt(p1)).toBe("ONE\ntwo\n");
    expect(readFileAt(p2)).toBe("ONE\ntwo\n");
    expect(statSync(p1).nlink).toBe(2);
    expect(textOf(result)).toContain("[W_HARDLINK_NONATOMIC]");
  });

  // POSIX permission bits do not exist on Windows (mode is always 0o666).
  it.skipIf(process.platform === "win32")("preserves file mode across atomic renames", async () => {
    const dir = makeProject();
    const path = writeFileAt(dir, "a.ts", "one\ntwo\n");
    require("fs").chmodSync(path, 0o755);
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it("fails the precommit check when the file changes during preparation (E_FILE_CHANGED)", async () => {
    const dir = makeProject();
    const path = writeFileAt(dir, "a.ts", "one\ntwo\n");
    // Read state as the tool would.
    const file = await loadAnchoredFile(path, "a.ts");
    // Simulate an external writer racing between read and commit.
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const ops = [
      {
        kind: "edit" as const,
        start: 0,
        end: 0,
        lines: ["ONE"],
        requestIndex: 0,
      },
    ];
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
    );
    const afterRaw = Buffer.from(encodeDocument(result.document), "utf-8");
    await expect(
      commitMutation({
        realPath: path,
        label: "a.ts",
        rawBefore: file.raw,
        checksumBefore: file.checksum,
        docBefore: file.doc,
        anchorsBefore: file.anchors,
        fingerprintsBefore: file.fingerprints,
        retiredBefore: file.retired,
        rawAfter: afterRaw,
        checksumAfter: sha256Hex(afterRaw),
        docAfter: result.document,
        anchorsAfter: result.anchors,
        fingerprintsAfter: fingerprintHexes(
          result.document.lines.map((l) => l.text),
        ),
        retiredAfter: new Set([...file.retired, ...result.retiredAdded]),
        transactionId: newTransactionId(),
        keepUndo: true,
        warnings: [],
      }),
    ).rejects.toThrow(/E_FILE_CHANGED/);
    // The file keeps the external content; the journal was rolled back.
    expect(readFileAt(path)).toBe("one\ntwo\nthree\n");
    const store = await loadStore();
    const pendingCount = store.db
      .prepare("SELECT COUNT(*) AS n FROM pending_transactions")
      .get()!.n as number;
    expect(pendingCount).toBe(0);
  });

  it("cleans up stale temp files", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const stale = join(dir, ".tmp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    require("fs").writeFileSync(stale, "stale", "utf-8");
    const old = Date.now() - 2 * 60 * 60 * 1000;
    require("fs").utimesSync(stale, new Date(old), new Date(old));
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    expect(require("fs").existsSync(stale)).toBe(false);
  });

  it("reports E_PATH_CHANGED when the resolved target changes", async () => {
    const dir = makeProject();
    const path = writeFileAt(dir, "a.ts", "one\ntwo\n");
    const file = await loadAnchoredFile(path, "a.ts");
    // Replace the file with a symlink to another target before commit.
    unlinkSync(path);
    symlinkSync(join(dir, "other.ts"), path);
    writeFileAt(dir, "other.ts", "other\n");
    const ops = [
      {
        kind: "edit" as const,
        start: 0,
        end: 0,
        lines: ["ONE"],
        requestIndex: 0,
      },
    ];
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
    );
    const afterRaw = Buffer.from(encodeDocument(result.document), "utf-8");
    await expect(
      commitMutation({
        realPath: path,
        label: "a.ts",
        rawBefore: file.raw,
        checksumBefore: file.checksum,
        docBefore: file.doc,
        anchorsBefore: file.anchors,
        fingerprintsBefore: file.fingerprints,
        retiredBefore: file.retired,
        rawAfter: afterRaw,
        checksumAfter: sha256Hex(afterRaw),
        docAfter: result.document,
        anchorsAfter: result.anchors,
        fingerprintsAfter: fingerprintHexes(
          result.document.lines.map((l) => l.text),
        ),
        retiredAfter: new Set([...file.retired, ...result.retiredAdded]),
        transactionId: newTransactionId(),
        keepUndo: true,
        warnings: [],
      }),
    ).rejects.toThrow(/E_PATH_CHANGED/);
  });

  it("cleans the journal when target inspection fails", async () => {
    const dir = makeProject();
    const first = join(dir, "first.ts");
    const second = join(dir, "second.ts");
    symlinkSync(second, first);
    symlinkSync(first, second);
    const before = decodeDocument(Buffer.from("one\n", "utf-8"), "first.ts");
    const after = decodeDocument(Buffer.from("ONE\n", "utf-8"), "first.ts");
    await expect(
      commitMutation({
        realPath: first,
        label: "first.ts",
        rawBefore: Buffer.from("one\n", "utf-8"),
        checksumBefore: sha256Hex(Buffer.from("one\n", "utf-8")),
        docBefore: before,
        anchorsBefore: ["A000"],
        fingerprintsBefore: fingerprintHexes(["one"]),
        retiredBefore: new Set(),
        rawAfter: Buffer.from("ONE\n", "utf-8"),
        checksumAfter: sha256Hex(Buffer.from("ONE\n", "utf-8")),
        docAfter: after,
        anchorsAfter: ["B000"],
        fingerprintsAfter: fingerprintHexes(["ONE"]),
        retiredAfter: new Set(["A000"]),
        transactionId: newTransactionId(),
        keepUndo: true,
        warnings: [],
      }),
    ).rejects.toThrow(/ELOOP|symbolic links/);
    const store = await loadStore();
    const pending = store.db
      .prepare("SELECT COUNT(*) AS n FROM pending_transactions")
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });
});

describe("atomic write internals (spec §44–§45)", () => {
  it("writeInPlace truncates the stale tail when the replacement is shorter", async () => {
    const dir = makeProject();
    const p = join(dir, "shrink.txt");
    writeFileSync(p, "one\ntwo\nthree\nfour\n");
    await writeInPlace(p, Buffer.from("X\nY\n"));
    expect(readFileSync(p, "utf8")).toBe("X\nY\n");
  });

  it("writeInPlace grows the file when the replacement is longer", async () => {
    const dir = makeProject();
    const p = join(dir, "grow.txt");
    writeFileSync(p, "a\n");
    await writeInPlace(p, Buffer.from("a\nb\nc\n"));
    expect(readFileSync(p, "utf8")).toBe("a\nb\nc\n");
  });

  it("precommitVerify compares beyond the first 64 KiB chunk", async () => {
    const dir = makeProject();
    const p = join(dir, "big.bin");
    const original = Buffer.alloc(200 * 1024, 7);
    writeFileSync(p, original);
    const tampered = Buffer.from(original);
    tampered[150 * 1024] = 9;
    writeFileSync(p, tampered);
    await expect(precommitVerify(p, p, original)).rejects.toThrow(
      /E_FILE_CHANGED/,
    );
    // Equal multi-chunk content passes the chunked compare.
    await expect(precommitVerify(p, p, tampered)).resolves.toBeUndefined();
  });

  it("reports a disappeared existing target as a file change", async () => {
    const dir = makeProject();
    const p = join(dir, "gone.txt");
    const original = Buffer.from("one\ntwo\n", "utf-8");
    writeFileSync(p, original);
    unlinkSync(p);
    await expect(precommitVerify(p, p, original)).rejects.toThrow(
      /E_FILE_CHANGED/,
    );
  });
});
