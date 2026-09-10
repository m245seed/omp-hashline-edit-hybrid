import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt } from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed, servedText } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { ANCHOR_RE } from "../../src/anchors/alphabet";
import { join } from "path";
import { readFileSync } from "fs";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();

;

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("read tool (spec §12, §25)", () => {
  it("renders anchor rows and records served state", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "function hello() {\n  console.log(\"world\");\n}\n");
    const result = await runTool(readTool, { path: "a.ts" }, dir);
    expect(result.isError).toBeFalsy();
    const rows = textOf(result).split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(ANCHOR_RE.test(row.slice(0, 4))).toBe(true);
    }
    expect(rows[1]).toContain("console.log");
    // Served under the real path.
    const realPath = join(dir, "a.ts");
    const anchor = rows[0]!.slice(0, 4);
    expect(servedText(realPath, anchor)).toBe("function hello() {");
    const details = result.details as { revision?: string; totalLines?: number };
    expect(details.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(details.totalLines).toBe(3);
  });

  it("supports offset and limit with pagination hints", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "1\n2\n3\n4\n5\n");
    const r1 = await runTool(readTool, { path: "a.ts", offset: 2, limit: 2 }, dir);
    const text = textOf(r1);
    expect(text).toContain("[Showing lines 2-3 of 5. Use offset=4 to continue.]");
    const rows = text.split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.map((r) => r.slice(5))).toEqual(["2", "3"]);
  });

  it("reports offsets beyond the file end", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "1\n2\n");
    const result = await runTool(readTool, { path: "a.ts", offset: 9 }, dir);
    expect(textOf(result)).toContain("beyond end of file (2 lines total)");
  });

  it("handles an empty file with an anchor row (not served as content)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "");
    const result = await runTool(readTool, { path: "a.ts" }, dir);
    const text = textOf(result);
    expect(text).toContain("[File is empty.");
    const anchor = text.match(/^([A-Za-z0-9]{4})│/)?.[1]!;
    expect(ANCHOR_RE.test(anchor)).toBe(true);
    expect(servedText(join(dir, "a.ts"), anchor)).toBe("");
  });

  it("omits oversized lines and does not serve them (spec §25)", async () => {
    const dir = makeProject();
    const big = "x".repeat(300 * 1024);
    writeFileAt(dir, "a.ts", `small\n${big}\nend\n`);
    const result = await runTool(readTool, { path: "a.ts" }, dir);
    const text = textOf(result);
    expect(text).toContain("[Line 2 omitted:");
    expect(text).not.toContain("xxxxx");
    // The oversized line exposes no anchor and is not served.
    const realPath = join(dir, "a.ts");
    const rows = text.split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.length).toBe(2);
    // Any anchor in the file is served only for shown lines.
    const smallAnchor = rows[0]!.slice(0, 4);
    expect(servedText(realPath, smallAnchor)).toBe("small");
  });

  it("rejects directories and non-files", async () => {
    const dir = makeProject();
    await expect(
      runTool(readTool, { path: "." }, dir),
    ).rejects.toThrow(/directory.*glob\(\).*grep\(\)/);
  });

  it("guides missing paths without recursive read hints", async () => {
    const dir = makeProject();
    await expect(
      runTool(readTool, { path: "missing.ts" }, dir),
    ).rejects.toThrow(/does not exist.*cannot be read or edited.*write\(\)/);
  });

  it("rejects unsupported encodings", async () => {
    const dir = makeProject();
    require("fs").writeFileSync(join(dir, "utf16.ts"), Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    await expect(runTool(readTool, { path: "utf16.ts" }, dir)).rejects.toThrow(/E_ENCODING_UNSUPPORTED/);
  });

  it("rejects binary files", async () => {
    const dir = makeProject();
    const buf = Buffer.alloc(64);
    buf.write("hello", 0);
    buf[10] = 0;
    require("fs").writeFileSync(join(dir, "b.bin"), buf);
    await expect(runTool(readTool, { path: "b.bin" }, dir)).rejects.toThrow(/E_BINARY_FILE/);
  });

  it("rejects oversized files", async () => {
    const dir = makeProject();
    const path = join(dir, "huge.ts");
    require("fs").writeFileSync(path, "x".repeat(101 * 1024 * 1024));
    await expect(runTool(readTool, { path: "huge.ts" }, dir)).rejects.toThrow(/E_FILE_TOO_LARGE/);
    require("fs").unlinkSync(path);
  });

  it("keeps anchors stable across reads (persistence)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "alpha\nbeta\ngamma\n");
    const r1 = await runTool(readTool, { path: "a.ts" }, dir);
    const r2 = await runTool(readTool, { path: "a.ts" }, dir);
    expect(textOf(r1)).toBe(textOf(r2));
  });

  it("defaults to a 2000-line page with a continuation hint", async () => {
    const dir = makeProject();
    writeFileAt(
      dir,
      "a.ts",
      Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    );
    const result = await runTool(readTool, { path: "a.ts" }, dir);
    const text = textOf(result);
    const rows = text.split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.length).toBe(2000);
    expect(text).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
    const details = result.details as { shownLines?: number; nextOffset?: number };
    expect(details.shownLines).toBe(2000);
    expect(details.nextOffset).toBe(2001);

    // Continuing the pagination keeps anchors stable.
    const next = await runTool(readTool, { path: "a.ts", offset: 2001 }, dir);
    const nextRows = textOf(next).split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(nextRows.length).toBe(500);
    expect(nextRows[0]!.slice(5)).toBe("line 2001");
    // Pagination is anchor-stable: the same page read twice is identical.
    const nextAgain = await runTool(readTool, { path: "a.ts", offset: 2001 }, dir);
    expect(textOf(nextAgain)).toBe(textOf(next));
  });

  it("numbers omitted oversized lines absolutely for offset reads", async () => {
    const dir = makeProject();
    const big = "x".repeat(300 * 1024);
    writeFileAt(dir, "a.ts", "l1\nl2\nl3\nl4\nl5\n" + big + "\nl7\n");
    const result = await runTool(readTool, { path: "a.ts", offset: 4 }, dir);
    const text = textOf(result);
    expect(text).toContain("[Line 6 omitted:");
    expect(text).not.toContain("xxxxx");
    // shownLines counts only complete rows; the omission is not a shown line.
    const details = result.details as { shownLines?: number };
    expect(details.shownLines).toBe(3);
  });

  it("preserves anchors through external insertion (reconciliation)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "alpha\nbeta\ngamma\n");
    const r1 = await runTool(readTool, { path: "a.ts" }, dir);
    const rows1 = textOf(r1).split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    const betaRow = rows1.find((r) => r.endsWith("beta"))!;
    const betaAnchor = betaRow.slice(0, 4);

    // External editor inserts a line above beta.
    writeFileAt(dir, "a.ts", "alpha\nnew\nbeta\ngamma\n");
    const r2 = await runTool(readTool, { path: "a.ts" }, dir);
    const rows2 = textOf(r2).split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows2.length).toBe(4);
    const betaRow2 = rows2.find((r) => r.endsWith("beta"))!;
    expect(betaRow2.slice(0, 4)).toBe(betaAnchor);
  });

  it("lets the model edit after read without re-reading", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "alpha\nbeta\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const rows = textOf(read).split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    const betaAnchor = rows.find((r) => r.endsWith("beta"))!.slice(0, 4);
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [betaAnchor, betaAnchor], lines: ["BETA"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("alpha\nBETA\n");
  });
  it("truncates between complete rows at the byte budget with a correct continuation offset (PH-OUTPUT-003/006)", async () => {
    const dir = makeProject();
    // 3000 lines of ~300 bytes: the default 2000-line page exceeds the
    // 512KB total budget, so the read must cut between complete rows.
    const line = "x".repeat(300);
    const content = Array.from({ length: 3000 }, (_, i) => `${i} ${line}`).join("\n") + "\n";
    writeFileAt(dir, "big.ts", content);
    const page1 = await runTool(readTool, { path: "big.ts" }, dir);
    expect(page1.isError).toBeFalsy();
    const nextOffset = (page1.details as { nextOffset?: number }).nextOffset;
    expect(nextOffset).toBeDefined();
    expect(textOf(page1)).toContain("Output truncated at the 512KB budget");
    // The generator embeds 0-based i in each row text; row `i` is 1-based line i+1.
    const rowRe = /^[A-Za-z0-9]{4}│(\d+) x+$/;
    const shown = textOf(page1)
      .split("\n")
      .flatMap((l) => {
        const m = l.match(rowRe);
        return m ? [Number.parseInt(m[1]!, 10)] : [];
      });
    expect(shown.length).toBeGreaterThan(0);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]!).toBe(shown[i - 1]! + 1);
    }
    expect(nextOffset!).toBe(shown[shown.length - 1]! + 2);
    // Continuing from nextOffset neither repeats nor skips a line.
    const page2 = await runTool(readTool, { path: "big.ts", offset: nextOffset }, dir);
    const firstRow = textOf(page2).split("\n").find((l) => rowRe.test(l))!;
    expect(Number.parseInt(firstRow.match(rowRe)![1]!, 10)).toBe(shown[shown.length - 1]! + 1);
  });

  it("rejects non-object params with E_BAD_SHAPE instead of crashing", async () => {
    const dir = makeProject();
    await expect(runTool(readTool, null, dir)).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(runTool(readTool, "a.ts", dir)).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(runTool(readTool, 42, dir)).rejects.toThrow(/E_BAD_SHAPE/);
  });
});

