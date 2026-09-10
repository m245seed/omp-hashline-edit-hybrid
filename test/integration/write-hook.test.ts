import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt, readFileAt, anchorsFromRead, makeFakePi } from "../support/tools";

import { resetStoreForTests, loadStore } from "../../src/state/database";
import { resetServed, servedText } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildUndoToolDef } from "../../src/tools/undo";
import { registerWriteHook } from "../../src/integration/write-hook";
import { getUndoRecord } from "../../src/state/undo";
import { join } from "path";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();
const undoTool = buildUndoToolDef();

;

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("write integration (spec §37, §38)", () => {
  it("clears undo after a successful write", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const one = anchorsFromRead(textOf(read)).get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    await loadStore();
    expect(getUndoRecord(join(dir, "a.ts"))).toBeDefined();

    const pi = makeFakePi({ value: true });
    registerWriteHook(pi as never, () => true);
    const result = await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "wrote a.ts" }],
        isError: false,
      } as never,
      { cwd: dir } as never,
    );
    expect(getUndoRecord(join(dir, "a.ts"))).toBeUndefined();
    // Auto-read preview is appended.
    const content = (result as { content?: Array<{ text?: string }> })?.content ?? [];
    expect(content.some((entry) => entry.text?.includes("Auto-read"))).toBe(true);
  });

  it("does not clear undo when write fails", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const one = anchorsFromRead(textOf(read)).get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);
    await loadStore();
    expect(getUndoRecord(join(dir, "a.ts"))).toBeDefined();

    const pi = makeFakePi({ value: true });
    registerWriteHook(pi as never, () => true);
    await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "failed" }],
        isError: true,
      } as never,
      { cwd: dir } as never,
    );
    expect(getUndoRecord(join(dir, "a.ts"))).toBeDefined();
  });

  it("reconciles anchors after write and keeps only matching served lines", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "alpha\nbeta\ngamma\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const alphaAnchor = anchors.get("alpha")!;
    expect(servedText(join(dir, "a.ts"), alphaAnchor)).toBe("alpha");

    // External write replaces beta with BETA.
    writeFileAt(dir, "a.ts", "alpha\nBETA\ngamma\n");
    const pi = makeFakePi({ value: false });
    registerWriteHook(pi as never, () => false);
    await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
      { cwd: dir } as never,
    );
    // alpha still matches -> authorization survives.
    expect(servedText(join(dir, "a.ts"), alphaAnchor)).toBe("alpha");
  });

  it("skips the hook for non-write tools", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const pi = makeFakePi({ value: true });
    registerWriteHook(pi as never, () => true);
    const result = await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "read",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "x" }],
        isError: false,
      } as never,
      { cwd: dir } as never,
    );
    expect(result).toBeUndefined();
  });

  it("undo works after the write hook has reconciled anchors", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const one = anchorsFromRead(textOf(read)).get("one")!;
    await runTool(editTool, { path: "a.ts", edits: [{ range: [one, one], lines: ["ONE"] }] }, dir);

    const pi = makeFakePi({ value: false });
    registerWriteHook(pi as never, () => false);
    await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "a.ts" },
        content: [{ type: "text", text: "ok" }],
        isError: false,
      } as never,
      { cwd: dir } as never,
    );
    await expect(runTool(undoTool, { path: "a.ts" }, dir)).rejects.toThrow(/E_NO_UNDO/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("ONE\ntwo\n");
  });
});

describe("write hook failure handling", () => {
  it("reports auto-read failure without breaking the write result", async () => {
    const dir = makeProject();
    // A binary file cannot be auto-read as text.
    require("fs").writeFileSync(join(dir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    const pi = makeFakePi({ value: true });
    registerWriteHook(pi as never, () => true);
    const result = await (pi.handlers.get("tool_result") as (e: never, c: never) => Promise<unknown>)(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "bin.dat" },
        content: [{ type: "text", text: "wrote bin.dat" }],
        isError: false,
      } as never,
      { cwd: dir } as never,
    );
    const content = (result as { content?: Array<{ text?: string }> })?.content ?? [];
    expect(content.some((entry) => entry.text?.includes("Auto-read failed"))).toBe(true);
    expect(content.some((entry) => entry.text?.includes("wrote bin.dat"))).toBe(true);
  });
});
