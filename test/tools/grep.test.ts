import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt } from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed, servedText } from "../../src/served/ledger";
import { buildGrepToolDef } from "../../src/tools/grep";
import { buildEditToolDef } from "../../src/tools/edit";
import { ANCHOR_RE } from "../../src/anchors/alphabet";
import { join } from "path";
import { mkdirSync } from "fs";

const grepTool = buildGrepToolDef();
const editTool = buildEditToolDef();

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("grep tool (spec §24)", () => {
  it("returns anchored match lines that are immediately editable", async () => {
    const dir = makeProject();
    mkdirSync(join(dir, "src"));
    writeFileAt(
      dir,
      "src/foo.ts",
      "function parseInput(value) {\n  return value.trim();\n}\n",
    );
    const result = await runTool(
      grepTool,
      { pattern: "parseInput", path: "." },
      dir,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("src/foo.ts");
    const rows = text.split("\n").filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("function parseInput(value) {");
    const anchor = rows[0]!.slice(0, 4);
    expect(ANCHOR_RE.test(anchor)).toBe(true);

    // grep → edit without a read (spec §24).
    const edited = await runTool(
      editTool,
      {
        path: "src/foo.ts",
        edits: [
          {
            range: [anchor, anchor],
            lines: ["function parseInput(value: string) {"],
          },
        ],
      },
      dir,
    );
    expect(edited.isError).toBeFalsy();
    expect(require("fs").readFileSync(join(dir, "src/foo.ts"), "utf-8")).toBe(
      "function parseInput(value: string) {\n  return value.trim();\n}\n",
    );
  });

  it("serves match and context lines", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo target\nthree\nfour\n");
    const result = await runTool(
      grepTool,
      { pattern: "target", path: ".", context: 1 },
      dir,
    );
    const rows = textOf(result)
      .split("\n")
      .filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    expect(rows.length).toBe(3);
    // All three shown rows are served.
    for (const row of rows) {
      expect(servedText(join(dir, "a.ts"), row.slice(0, 4))).toBe(row.slice(5));
    }
  });
  it("normalizes CRLF match rows for exact served edits", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\r\ntwo target\r\nthree\r\n");
    const result = await runTool(
      grepTool,
      { pattern: "target", path: "a.ts" },
      dir,
    );
    const text = textOf(result);
    const row = text.split("\n").find((line) => line.includes("two target"));
    expect(row).toBeDefined();
    const anchor = row!.slice(0, 4);
    expect(row).toBe(`${anchor}│two target`);
    expect(servedText(join(dir, "a.ts"), anchor)).toBe("two target");

    const edited = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [anchor, anchor], lines: ["TWO target"] }] },
      dir,
    );
    expect(edited.isError).toBeFalsy();
    expect(require("fs").readFileSync(join(dir, "a.ts"), "utf-8")).toBe(
      "one\r\nTWO target\r\nthree\r\n",
    );
  });

  it("supports literal search, ignoreCase, globs, and limits", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "Alpha\nbeta\n");
    writeFileAt(dir, "b.js", "alpha\n");
    writeFileAt(dir, "c.ts", "ALPHA\n");

    const literal = await runTool(
      grepTool,
      { pattern: "Alpha", path: ".", literal: true },
      dir,
    );
    expect(textOf(literal)).toContain("Alpha");

    const ic = await runTool(
      grepTool,
      { pattern: "alpha", path: ".", ignoreCase: true },
      dir,
    );
    const icText = textOf(ic);
    expect(icText).toContain("Alpha");
    expect(icText).toContain("alpha");
    expect(icText).toContain("ALPHA");

    const globbed = await runTool(
      grepTool,
      { pattern: "alpha", path: ".", glob: "*.ts", ignoreCase: true },
      dir,
    );
    const globbedText = textOf(globbed);
    expect(globbedText).not.toContain("b.js");

    const limited = await runTool(
      grepTool,
      { pattern: "alpha", path: ".", ignoreCase: true, limit: 1 },
      dir,
    );
    const limitedText = textOf(limited);
    expect(limitedText).toContain("matches limit reached");
    expect(limited.details?.matches).toBe(1);
    expect(
      limitedText
        .split("\n")
        .filter((line) => /^[A-Za-z0-9]{4}│/.test(line)),
    ).toHaveLength(1);
  });
  it("excludes buffered context for matches beyond the limit", async () => {
    const dir = makeProject();
    writeFileAt(
      dir,
      "a.ts",
      "first before\nfirst TARGET\nfirst after\ngap\nsecond before\nsecond TARGET\nsecond after\n",
    );
    const result = await runTool(
      grepTool,
      { pattern: "TARGET", path: "a.ts", context: 1, limit: 1 },
      dir,
    );
    const text = textOf(result);
    expect(result.details?.matches).toBe(1);
    expect(text).toContain("first before");
    expect(text).toContain("first TARGET");
    expect(text).toContain("first after");
    expect(text).not.toContain("second before");
    expect(text).not.toContain("second TARGET");
    expect(text).not.toContain("second after");
  });

  it("renders no matches cleanly", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "nothing here\n");
    const result = await runTool(grepTool, { pattern: "zzzz", path: "." }, dir);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No matches found");
  });

  it("guides missing search paths", async () => {
    const dir = makeProject();
    await expect(
      runTool(grepTool, { pattern: "x", path: "missing.ts" }, dir),
    ).rejects.toThrow(
      /Path not found.*Verify the path.*one existing file or directory.*glob\(\)/,
    );
  });

  it("validates the pattern field", async () => {
    const dir = makeProject();
    await expect(runTool(grepTool, { path: "." }, dir)).rejects.toThrow(
      /E_BAD_SHAPE/,
    );
  });

  it("rejects malformed optional option types", async () => {
    const dir = makeProject();
    await expect(
      runTool(grepTool, { pattern: "x", path: 1 }, dir),
    ).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(
      runTool(grepTool, { pattern: "x", ignoreCase: "yes" }, dir),
    ).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(
      runTool(grepTool, { pattern: "x", literal: 1 }, dir),
    ).rejects.toThrow(/E_BAD_SHAPE/);
    await expect(
      runTool(grepTool, { pattern: "x", path: "bad\0path" }, dir),
    ).rejects.toThrow(/E_BAD_SHAPE/);
  });

  it("does not serve lines from files it cannot read", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "find me\n");
    require("fs").writeFileSync(
      join(dir, "bin.dat"),
      Buffer.from([0xff, 0xfe, 0x61, 0x00]),
    );
    const result = await runTool(grepTool, { pattern: "find", path: "." }, dir);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("a.ts");
  });

  it("notices when matching files were skipped as unreadable", async () => {
    const dir = makeProject();
    require("fs").writeFileSync(
      join(dir, "bin.dat"),
      Buffer.from([0xff, 0xfe, 0x61, 0x00]),
    );
    const result = await runTool(
      grepTool,
      { pattern: "a", path: ".", glob: "bin.dat" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 file(s) skipped");
    expect(text).not.toContain("No matches found");
  });

  it("serves only rows that survive the output limit (spec §8/§9)", async () => {
    const dir = makeProject();
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`line ${i} ${"y".repeat(200)}`);
    writeFileAt(dir, "big.log", lines.join("\n") + "\n");
    const result = await runTool(
      grepTool,
      { path: "big.log", pattern: "line", limit: 400 },
      dir,
    );
    const text = textOf(result);
    expect(text).toContain("output limit reached");
    const visibleRows = text
      .split("\n")
      .filter((l) => /^[A-Za-z0-9]{4}│/.test(l));
    const { getLedger } = await import("../../src/served/ledger");
    const ledger = getLedger().get(join(dir, "big.log"));
    const servedCount = ledger ? ledger.size : 0;
    expect(visibleRows.length).toBeGreaterThan(0);
    expect(servedCount).toBe(visibleRows.length);
    // Every served entry corresponds to a row the model actually received.
    for (const row of visibleRows) {
      expect(ledger?.get(row.slice(0, 4))?.exactText).toBe(row.slice(5));
    }
  });

  it("shows no anchors for CR-only files instead of misaligned rows", async () => {
    const dir = makeProject();
    writeFileAt(dir, "cr.txt", "alpha\rbravo\rcharlie\r");
    const result = await runTool(
      grepTool,
      { path: "cr.txt", pattern: "bravo" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("CR-only line endings");
    expect(text).not.toMatch(/^[A-Za-z0-9]{4}│/m);
    const { getLedger } = await import("../../src/served/ledger");
    expect(getLedger().get(join(dir, "cr.txt"))).toBeUndefined();
  });
});

describe("grep error handling", () => {
  it("reports ripgrep failures with invalid patterns", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "hello\n");
    await expect(
      runTool(grepTool, { pattern: "[", path: "." }, dir),
    ).rejects.toThrow(/regex parse error/);
  });

  it("aborts cleanly when the signal fires", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "hello\n".repeat(5000));
    const controller = new AbortController();
    const promise = (grepTool as any).execute(
      "abort-call",
      { pattern: "hello", path: "." },
      controller.signal,
      undefined,
      { cwd: dir },
    );
    // Abort before the run finishes.
    setTimeout(() => controller.abort(), 5);
    await expect(promise).rejects.toThrow(/aborted|Operation aborted/i);
  });
});
