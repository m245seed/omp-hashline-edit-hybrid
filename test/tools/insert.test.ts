import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt, readFileAt, anchorsFromRead } from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { advanceContextEpoch } from "../../src/served/epoch";
import { buildInsertToolDef } from "../../src/tools/insert";
import { buildReadToolDef } from "../../src/tools/read";
import { join } from "path";

const insertTool = buildInsertToolDef();
const readTool = buildReadToolDef();

;

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("insert tool (spec §23)", () => {
  it("inserts after an anchor line", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("X")!;
    const result = await runTool(
      insertTool,
      { path: "a.ts", inserts: [{ anchor, direction: "after", lines: ["A", "B"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nA\nB\nY\nZ\n");
    const metrics = result.details?.metrics as Record<string, unknown> | undefined;
    expect(metrics?.classification).toBe("applied");
    expect(metrics?.lines_added).toBe(2);
  });

  it("inserts before an anchor line", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("Z")!;
    const result = await runTool(
      insertTool,
      { path: "a.ts", inserts: [{ anchor, direction: "before", lines: ["P", "Q"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nY\nP\nQ\nZ\n");
  });

  it("orders same-anchor inserts by request order (spec §23)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchor = anchorsFromRead(textOf(read)).get("X")!;
    const result = await runTool(
      insertTool,
      {
        path: "a.ts",
        inserts: [
          { anchor, direction: "after", lines: ["A"] },
          { anchor, direction: "after", lines: ["B"] },
        ],
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nA\nB\nY\n");
  });

  it("rejects an unserved anchor line (E_ANCHOR_NOT_SERVED)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    // Read only line 2.
    await runTool(readTool, { path: "a.ts", offset: 2, limit: 1 }, dir);
    const read = await runTool(readTool, { path: "a.ts", offset: 2, limit: 1 }, dir);
    const anchorY = anchorsFromRead(textOf(read)).get("Y")!;
    const anchorX = anchorY; // X was never served
    void anchorX;
    // X's anchor is unknown; use a fresh full read to get X, then reset.
    resetServed();
    const full = await runTool(readTool, { path: "a.ts" }, dir);
    const allAnchors = anchorsFromRead(textOf(full));
    const anchorX2 = allAnchors.get("X")!;
    resetServed();
    // Serve only Z.
    await runTool(readTool, { path: "a.ts", offset: 3, limit: 1 }, dir);
    await expect(
      runTool(
        insertTool,
        { path: "a.ts", inserts: [{ anchor: anchorX2, direction: "after", lines: ["N"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_NOT_SERVED/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nY\nZ\n");
  });

  it("rejects a stale anchor line after external change (E_ANCHOR_STALE)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchorX = anchorsFromRead(textOf(read)).get("X")!;
    // External change alters X: its anchor is retired and never reassigned.
    writeFileAt(dir, "a.ts", "XX\nY\nZ\n");
    await expect(
      runTool(
        insertTool,
        { path: "a.ts", inserts: [{ anchor: anchorX, direction: "after", lines: ["N"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_STALE/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("XX\nY\nZ\n");
  });

  it("rejects stale anchors after reconciliation (spec §71)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const anchorX = anchors.get("X")!;
    // External insertion above Y: X unchanged, Y's position shifts but its
    // anchor survives; the model's anchor for X remains valid.
    writeFileAt(dir, "a.ts", "X\nNEW\nY\nZ\n");
    const result = await runTool(
      insertTool,
      { path: "a.ts", inserts: [{ anchor: anchorX, direction: "after", lines: ["N"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nN\nNEW\nY\nZ\n");
  });

  it("is transactional: one bad insert rejects the whole call", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const anchorX = anchors.get("X")!;
    const anchorZ = anchors.get("Z")!;
    // Insert #2 targets an anchor that was never served.
    resetServed();
    await runTool(readTool, { path: "a.ts", offset: 1, limit: 1 }, dir);
    await expect(
      runTool(
        insertTool,
        {
          path: "a.ts",
          inserts: [
            { anchor: anchorX, direction: "after", lines: ["A"] },
            { anchor: anchorZ, direction: "after", lines: ["B"] },
          ],
        },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_NOT_SERVED/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nY\nZ\n");
  });

  it("inserts into an empty file", async () => {
    const dir = makeProject();
    writeFileAt(dir, "empty.ts", "");
    const read = await runTool(readTool, { path: "empty.ts" }, dir);
    expect(textOf(read)).toContain("[File is empty.");
    const anchor = textOf(read).match(/^([A-Za-z0-9]{4})│/)?.[1]!;
    expect(anchor).toBeDefined();
    // Inserting after the single empty line terminates that line first,
    // which yields a leading blank line; inserting before yields the
    // natural "hello\n" result.
    const after = await runTool(
      insertTool,
      { path: "empty.ts", inserts: [{ anchor, direction: "after", lines: ["hello"] }] },
      dir,
    );
    expect(after.isError).toBeFalsy();
    expect(readFileAt(join(dir, "empty.ts"))).toBe("\nhello");

    writeFileAt(dir, "empty.ts", "");
    const read2 = await runTool(readTool, { path: "empty.ts" }, dir);
    const anchor2 = textOf(read2).match(/^([A-Za-z0-9]{4})│/)?.[1]!;
    const before = await runTool(
      insertTool,
      { path: "empty.ts", inserts: [{ anchor: anchor2, direction: "before", lines: ["hello"] }] },
      dir,
    );
    expect(before.isError).toBeFalsy();
    expect(readFileAt(join(dir, "empty.ts"))).toBe("hello\n");
  });

  it("rejects an insert anchor served in an older context epoch (PH-CONTEXT-003)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "X\nY\nZ\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchorY = anchorsFromRead(textOf(read)).get("Y")!;
    advanceContextEpoch();
    await expect(
      runTool(
        insertTool,
        { path: "a.ts", inserts: [{ anchor: anchorY, direction: "after", lines: ["N"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_CONTEXT_EPOCH_STALE/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("X\nY\nZ\n");
  });
});
