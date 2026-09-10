import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { join } from "path";
import { withStateDir } from "../support/env";
import { makeProject, readFileAt, runTool, textOf, writeFileAt, anchorsFromRead } from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import {
  getContextEpoch,
  advanceContextEpoch,
  resetContextEpoch,
} from "../../src/served/epoch";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildUndoToolDef } from "../../src/tools/undo";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();
const undoTool = buildUndoToolDef();

;

beforeEach(() => {
  withStateDir();
  resetServed();
  resetContextEpoch();
});

afterEach(async () => {
  await resetStoreForTests();
  resetContextEpoch();
});

describe("context epochs (PH-CONTEXT-001..005)", () => {
  it("starts at epoch 1 and advances monotonically", () => {
    expect(getContextEpoch()).toBe(1);
    const next = advanceContextEpoch();
    expect(next).toBe(2);
    expect(getContextEpoch()).toBe(2);
  });


  it("anchors from an older epoch no longer authorize destructive edits", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const two = anchors.get("two")!;

    // Context rebuilt (compaction / tree navigation).
    advanceContextEpoch();

    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [two, two], lines: ["TWO"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_CONTEXT_EPOCH_STALE/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  it("an external change after compaction does not refresh old-epoch authorization", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\nfour\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const two = anchors.get("two")!;

    advanceContextEpoch();
    // External edit elsewhere in the file: identical lines keep their
    // anchors, but the reconciliation transfer must keep their original
    // epoch instead of re-stamping them into the current one.
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\nFOUR\n");

    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [two, two], lines: ["TWO"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_CONTEXT_EPOCH_STALE/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\nthree\nFOUR\n");
  });

  it("re-reading in the new epoch re-authorizes the range", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    advanceContextEpoch();

    const reread = await runTool(readTool, { path: "a.ts" }, dir);
    const fresh = anchorsFromRead(textOf(reread));
    const two = fresh.get("two")!;
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [two, two], lines: ["TWO"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\nTWO\nthree\n");
    void anchors;
  });

  it("undo history is independent of the epoch (PH-CONTEXT-005)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] },
      dir,
    );
    advanceContextEpoch();
    // Undo still works across an epoch advance.
    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("served entries record the epoch they were served in", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    const { servedEntry } = await import("../../src/served/ledger");
    const read2 = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read2));
    const entry = servedEntry(join(dir, "a.ts"), anchors.get("one")!);
    expect(entry?.epoch).toBe(getContextEpoch());
    expect(entry?.servedAt).toBeDefined();
  });
});
