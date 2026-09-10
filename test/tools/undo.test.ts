import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt, readFileAt, anchorsFromRead } from "../support/tools";

import { resetStoreForTests, shutdownStore } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildReadToolDef } from "../../src/tools/read";
import { buildUndoToolDef } from "../../src/tools/undo";
import { join } from "path";

const editTool = buildEditToolDef();
const readTool = buildReadToolDef();
const undoTool = buildUndoToolDef();

async function readAnchors(dir: string, name: string): Promise<Map<string, string>> {
  const result = await runTool(readTool, { path: name }, dir);
  return anchorsFromRead(textOf(result));
}

;

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("undo tool (spec §32–§36)", () => {
  it("reverts the last transaction exactly, restoring anchors", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const anchors = await readAnchors(dir, "a.ts");
    const two = anchors.get("two")!;
    const r = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [two, two], lines: ["TWO"] }] },
      dir,
    );
    expect(r.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\nTWO\nthree\n");

    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(textOf(undo)).toContain("Undone");
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\nthree\n");

    // The pre-transaction anchor is live again.
    const after = await readAnchors(dir, "a.ts");
    expect(after.get("two")).toBe(two);
  });

  it("restores exact bytes: BOM, CRLF, final newline, trailing whitespace", async () => {
    const dir = makeProject();
    const original = "\uFEFFalpha\r\nbeta  \r\ngamma";
    writeFileAt(dir, "a.ts", original);
    const anchors = await readAnchors(dir, "a.ts");
    const beta = anchors.get("beta  ")!;
    const r = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [beta, beta], lines: ["BETA"] }] },
      dir,
    );
    expect(r.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("\uFEFFalpha\r\nBETA\r\ngamma");

    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe(original);
  });

  it("refuses to overwrite later modifications (E_UNDO_STALE)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const anchors = await readAnchors(dir, "a.ts");
    const one = anchors.get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    // External modification after the transaction.
    writeFileAt(dir, "a.ts", "ONE\ntwo\nthree\n");
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_UNDO_STALE/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("ONE\ntwo\nthree\n");
  });

  it("reports E_NO_UNDO when there is no history", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_NO_UNDO/);
  });

  it("survives a store restart (spec §36)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const anchors = await readAnchors(dir, "a.ts");
    const one = anchors.get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);

    // Simulate a process restart: close the store and reopen it.
    shutdownStore();
    await resetStoreForTests();

    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("restores anchors exactly after undo (spec §35)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "A111\nB222\nC333\n");
    const anchors = await readAnchors(dir, "a.ts");
    const b = anchors.get("B222")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [b, b], lines: ["TWO"] }] }, dir);
    // B222's anchor is retired; a fresh anchor exists for TWO.
    const after = await readAnchors(dir, "a.ts");
    expect(after.get("B222")).toBeUndefined();
    const twoAnchor = after.get("TWO")!;
    expect(twoAnchor).toBeDefined();

    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    const restored = await readAnchors(dir, "a.ts");
    expect(restored.get("B222")).toBe(b);
    expect(restored.get("TWO")).toBeUndefined();

    // The undone transaction's anchor is retired and never reused.
    const r2 = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [restored.get("B222")!, restored.get("B222")!], lines: ["X"] }] },
      dir,
    );
    expect(r2.isError).toBeFalsy();
    const final = await readAnchors(dir, "a.ts");
    expect(final.get("X")).not.toBe(twoAnchor);
  });

  it("reverts multi-range transactions as one unit", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "1\n2\n3\n4\n5\n");
    const anchors = await readAnchors(dir, "a.ts");
    const r = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          { range: [anchors.get("1")!, anchors.get("1")!], lines: ["ONE"] },
          { range: [anchors.get("5")!, anchors.get("5")!], lines: ["FIVE"] },
        ],
      },
      dir,
    );
    expect(r.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("ONE\n2\n3\n4\nFIVE\n");
    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("1\n2\n3\n4\n5\n");
  });

  it("is cleared by a later transaction (single-level history)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const anchors = await readAnchors(dir, "a.ts");
    const one = anchors.get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    const anchors2 = await readAnchors(dir, "a.ts");
    const one2 = anchors2.get("ONE")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one2, one2], lines: ["1"] }] }, dir);

    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("ONE\ntwo\n");
    // Only one undo level: undoing again reports E_NO_UNDO.
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_NO_UNDO/);
  });

  it("undo itself is crash-safe and records no new undo entry", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const anchors = await readAnchors(dir, "a.ts");
    const one = anchors.get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    // No new undo record was created by the undo itself.
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_NO_UNDO/);
  });
});

describe("undo tool edge cases", () => {
  it("reports E_UNDO_STALE when the file was deleted", async () => {
    const dir = makeProject();
    const file = join(dir, "a.ts");
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const anchors = await readAnchors(dir, "a.ts");
    const one = anchors.get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    require("fs").unlinkSync(file);
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_UNDO_STALE/);
  });

  it("validates the path field", async () => {
    const dir = makeProject();
    await expect(runTool(undoTool, { path: "" }, dir)).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("rejects non-object params with E_BAD_SHAPE instead of crashing", async () => {
    const dir = makeProject();
    await expect(runTool(undoTool, null, dir)).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(runTool(undoTool, ["a.ts"], dir)).rejects.toThrow(/E_BAD_SHAPE/);
  });
});
