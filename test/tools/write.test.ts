import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { withStateDir } from "../support/env";
import {
  makeProject,
  readFileAt,
  runTool,
  textOf,
  writeFileAt,
  anchorsFromRead,
} from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed, servedText } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildWriteToolDef } from "../../src/tools/write";
import { buildUndoToolDef } from "../../src/tools/undo";
import { getSnapshot } from "../../src/state/snapshots";

const readTool = buildReadToolDef();
const writeTool = buildWriteToolDef();
const undoTool = buildUndoToolDef();

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("write tool (spec §31.8, PH-WRITE-001..003)", () => {
  it("creates a new file atomically with a bounded anchored preview", async () => {
    const dir = makeProject();
    const result = await runTool(
      writeTool,
      { path: "new.ts", content: "alpha\nbeta\ngamma\n" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "new.ts"))).toBe("alpha\nbeta\ngamma\n");
    const text = textOf(result);
    expect(text).toContain("Created new.ts");
    // Preview rows carry anchors and become served.
    const anchors = anchorsFromRead(text);
    expect(anchors.get("alpha")).toBeDefined();
    expect(servedText(join(dir, "new.ts"), anchors.get("alpha")!)).toBe(
      "alpha",
    );
    // details.hashline marker (PH-PROTO-003).
    const hashline = result.details?.hashline as Record<string, unknown>;
    expect(hashline?.protocol).toBe("pi-hashline-result/1");
    expect(hashline?.outcome).toBe("success");
  });

  it("retires the synthetic empty-line anchor after creating content", async () => {
    const dir = makeProject();
    const result = await runTool(
      writeTool,
      { path: "new.ts", content: "alpha\n" },
      dir,
    );
    const active = anchorsFromRead(textOf(result)).get("alpha")!;
    const snapshot = getSnapshot(join(dir, "new.ts"));
    expect(snapshot?.retired.size).toBe(1);
    expect(snapshot?.retired.has(active)).toBe(false);
  });

  it("rejects overwriting an existing file without full-file authorization", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    await expect(
      runTool(writeTool, { path: "a.ts", content: "replaced\n" }, dir),
    ).rejects.toThrow(/E_ANCHOR_NOT_SERVED/);
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  it("allows overwrite after a full-file read in the current epoch", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    const result = await runTool(
      writeTool,
      { path: "a.ts", content: "fresh\n" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("fresh\n");
  });

  it("allows overwrite with the explicit replace_existing override", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const result = await runTool(
      writeTool,
      { path: "a.ts", content: "fresh\n", replace_existing: true },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("fresh\n");
  });

  it("creates an undo record so the previous content can be restored", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    await runTool(writeTool, { path: "a.ts", content: "fresh\n" }, dir);
    const undo = await runTool(undoTool, { path: "a.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("rejects content exceeding the byte limit", async () => {
    const dir = makeProject();
    const huge = "x".repeat(101 * 1024 * 1024);
    await expect(
      runTool(writeTool, { path: "big.ts", content: huge }, dir),
    ).rejects.toThrow(/E_FILE_TOO_LARGE/);
  });

  it("honors expected_revision CAS mode", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const revision = (read.details as { revision: string }).revision;
    await expect(
      runTool(
        writeTool,
        { path: "a.ts", content: "fresh\n", expected_revision: "0".repeat(64) },
        dir,
      ),
    ).rejects.toThrow(/E_FILE_REVISION_CHANGED/);
    const ok = await runTool(
      writeTool,
      { path: "a.ts", content: "fresh\n", expected_revision: revision },
      dir,
    );
    expect(ok.isError).toBeFalsy();
  });

  it("rejects malformed shapes", async () => {
    const dir = makeProject();
    await expect(runTool(writeTool, { path: "a.ts" }, dir)).rejects.toThrow(
      /E_BAD_SHAPE/,
    );
    await expect(
      runTool(
        writeTool,
        { path: "a.ts", content: "x", replace_existing: "yes" },
        dir,
      ),
    ).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("undo of a created file restores a consistent empty-file state", async () => {
    const dir = makeProject();
    await runTool(writeTool, { path: "new.ts", content: "alpha\nbeta\n" }, dir);
    expect(readFileAt(join(dir, "new.ts"))).toBe("alpha\nbeta\n");
    const undo = await runTool(undoTool, { path: "new.ts" }, dir);
    expect(undo.isError).toBeFalsy();
    expect(readFileAt(join(dir, "new.ts"))).toBe("");
    // The emptied file must remain a fully consistent anchored document.
    const reread = await runTool(readTool, { path: "new.ts" }, dir);
    expect(reread.isError).toBeFalsy();
    const anchors = anchorsFromRead(textOf(reread));
    const emptyAnchor = [...anchors.values()][0]!;
    expect(anchors.get("")).toBe(emptyAnchor);
  });

  it("rejects content with an unpaired UTF-16 surrogate", async () => {
    const dir = makeProject();
    await expect(
      runTool(writeTool, { path: "bad.ts", content: "a\uD800b" }, dir),
    ).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("rejects content exceeding the line limit", async () => {
    const dir = makeProject();
    const many = `${"x\n".repeat(250_001)}`;
    await expect(
      runTool(writeTool, { path: "lines.ts", content: many }, dir),
    ).rejects.toThrow(/E_FILE_TOO_LARGE/);
  });

  it("fails safely when the target directory does not exist", async () => {
    const dir = makeProject();
    await expect(
      runTool(writeTool, { path: "missing-dir/new.ts", content: "x\n" }, dir),
    ).rejects.toThrow(/E_ATOMIC_REPLACE_FAILED/);
  });

  it("rejects display-like content with E_DISPLAY_LIKE_CONTENT and writes nothing", async () => {
    const dir = makeProject();
    await expect(
      runTool(
        writeTool,
        { path: "notes.md", content: "plain\nAb31│pasted row\n" },
        dir,
      ),
    ).rejects.toThrow(/E_DISPLAY_LIKE_CONTENT/);
    expect(existsSync(join(dir, "notes.md"))).toBe(false);
  });

  it("writes display-like content literally with allow_display_like_content", async () => {
    const dir = makeProject();
    const result = await runTool(
      writeTool,
      {
        path: "notes.md",
        content: "Ab31│literal row\nplain\n",
        allow_display_like_content: true,
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(join(dir, "notes.md"))).toBe("Ab31│literal row\nplain\n");
  });

  it("preserves a UTF-8 BOM and CRLF endings byte-for-byte through the commit path", async () => {
    const dir = makeProject();
    const content = "\uFEFFone\r\ntwo\r\n";
    const result = await runTool(
      writeTool,
      { path: "bom-crlf.txt", content },
      dir,
    );
    expect(result.isError).toBeFalsy();
    // Raw bytes on disk are exactly the input bytes (BOM + CRLF preserved).
    const raw = require("fs").readFileSync(join(dir, "bom-crlf.txt"));
    expect(raw.equals(Buffer.from(content, "utf-8"))).toBe(true);
    // Decoded text read back is exactly the input string.
    expect(readFileAt(join(dir, "bom-crlf.txt"))).toBe(content);
    // The auto-preview contains anchored `one` and `two` rows.
    const text = textOf(result);
    const anchors = anchorsFromRead(text);
    expect(anchors.get("one")).toBeDefined();
    expect(anchors.get("two")).toBeDefined();
  });
});
