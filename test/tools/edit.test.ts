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

import { resetStoreForTests } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildReadToolDef } from "../../src/tools/read";
import { ANCHOR_RE } from "../../src/anchors/alphabet";
import { getLargeEditGuard, setLargeEditGuard } from "../../src/constants";

const editTool = buildEditToolDef();
const readTool = buildReadToolDef();

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("edit tool end-to-end (spec §13, §70)", () => {
  it("replaces two ranges in one atomic transaction", async () => {
    const dir = makeProject();
    writeFileAt(
      dir,
      "total.ts",
      "function total(items) {\n  let value = 0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return value;\n}\n",
    );
    const read = await runTool(readTool, { path: "total.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));

    const result = await runTool(
      editTool,
      {
        path: "total.ts",
        edits: [
          {
            range: [
              anchors.get("  let value = 0;")!,
              anchors.get("  let value = 0;")!,
            ],
            lines: ["  let value = 0.0;"],
          },
          {
            range: [
              anchors.get("  return value;")!,
              anchors.get("  return value;")!,
            ],
            lines: ["  return Math.round(value * 100) / 100;"],
          },
        ],
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    const diff = textOf(result);
    expect(diff).toContain("+");
    expect(diff).toContain("-");
    expect(readFileAt(joinPath(dir, "total.ts"))).toBe(
      "function total(items) {\n  let value = 0.0;\n  for (const item of items) {\n    value += item.price;\n  }\n  return Math.round(value * 100) / 100;\n}\n",
    );
    const metrics = result.details?.metrics as
      Record<string, unknown> | undefined;
    expect(metrics?.classification).toBe("applied");
    expect(metrics?.edits_attempted).toBe(2);
    expect(metrics?.edits_applied).toBe(2);
    expect(metrics?.lines_added).toBe(2);
    expect(metrics?.lines_removed).toBe(2);
    expect(metrics?.before_revision).toBeTypeOf("string");
    expect(metrics?.after_revision).toBeTypeOf("string");
    expect(metrics?.transaction_id).toBeTypeOf("string");
  });

  it("is chained: diff rows seed a follow-up edit without re-read", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    const r1 = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [
              anchorOf(
                textOf(await runTool(readTool, { path: "a.ts" }, dir)),
                "two",
              )!,
              anchorOf(
                textOf(await runTool(readTool, { path: "a.ts" }, dir)),
                "two",
              )!,
            ],
            lines: ["TWO", "two.5"],
          },
        ],
      },
      dir,
    );
    expect(r1.isError).toBeFalsy();
    // Extract the new anchor of "TWO" from the diff's "+" row.
    const diffText = textOf(r1);
    const plusRow = diffText.split("\n").find((l) => l.startsWith("+"));
    expect(plusRow).toBeDefined();
    const newAnchor = plusRow!.match(/^\+([A-Za-z0-9]{4})│/)?.[1];
    expect(newAnchor).toBeDefined();
    expect(ANCHOR_RE.test(newAnchor!)).toBe(true);

    // Follow-up edit using only the anchor from the diff — no re-read.
    const r2 = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [newAnchor!, newAnchor!], lines: ["TWO!!"] }],
      },
      dir,
    );
    expect(r2.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe(
      "one\nTWO!!\ntwo.5\nthree\n",
    );
  });

  it("rejects an unserved range with E_ANCHOR_NOT_SERVED and zero mutation", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\nfour\nfive\n");
    // Read only the first line.
    let read = await runTool(readTool, { path: "a.ts", limit: 1 }, dir);
    const first = anchorsFromRead(textOf(read)).get("one")!;
    expect(first).toBeDefined();

    // Read only the last line.
    read = await runTool(readTool, { path: "a.ts", offset: 5, limit: 1 }, dir);
    const last = anchorsFromRead(textOf(read)).get("five")!;
    expect(last).toBeDefined();

    // The interior (lines 2-4) was never shown.
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [first, last], lines: [] }] },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_NOT_SERVED/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe(
      "one\ntwo\nthree\nfour\nfive\n",
    );
  });

  it("detects stale served content (E_RANGE_STALE) after external change", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "start\nmiddle\nend\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const startAnchor = anchors.get("start")!;
    const endAnchor = anchors.get("end")!;
    expect(startAnchor).toBeDefined();
    expect(endAnchor).toBeDefined();

    // External formatter changes the middle line; the agent does not re-read.
    writeFileAt(dir, "a.ts", "start\nMIDDLE\nend\n");

    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [{ range: [startAnchor, endAnchor], lines: ["X"] }],
        },
        dir,
      ),
    ).rejects.toThrow(/E_RANGE_STALE/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("start\nMIDDLE\nend\n");
    // The fresh rows in the error become served, so a retry succeeds.
    const retry = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [startAnchor, endAnchor], lines: ["X"] }],
      },
      dir,
    );
    expect(retry.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("X\n");
  });

  it("rejects reversed ranges without swapping (spec §16)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const first = anchors.get("one")!;
    const last = anchors.get("three")!;
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [last, first], lines: ["X"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_RANGE_REVERSED/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  it("rejects overlapping multi-edits with zero mutation (spec §20, invariant D)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "1\n2\n3\n4\n5\n6\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const keys = [...anchors.values()];
    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [
            { range: [keys[0]!, keys[3]!], lines: ["X"] },
            { range: [keys[3]!, keys[5]!], lines: ["Y"] },
          ],
        },
        dir,
      ),
    ).rejects.toThrow(/E_RANGE_OVERLAP/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("1\n2\n3\n4\n5\n6\n");
  });

  it("rejects suspicious pasted hashline content (spec §17)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const [first] = [...anchors.values()];
    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [
            { range: [first!, first!], lines: ['Ab31│console.log("x")'] },
          ],
        },
        dir,
      ),
    ).rejects.toThrow(/E_DISPLAY_LIKE_CONTENT/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("writes suspicious content literally with the escape hatch", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const [first] = [...anchors.values()];
    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [first!, first!], lines: ["Ab31│literal"] }],
        allow_display_like_content: true,
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("Ab31│literal\ntwo\n");
  });

  it("rejects a replacement that duplicates boundary content before commit (spec §18, PH-EDIT-001/002)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [
            {
              range: [anchors.get("two")!, anchors.get("two")!],
              lines: ["two", "three"],
            },
          ],
        },
        dir,
      ),
    ).rejects.toThrow(/E_BOUNDARY_DUP/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  it("reports no-op transactions without touching the file (spec §21)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const before = readFileAt(joinPath(dir, "a.ts"));
    const [first] = [...anchors.values()];
    const result = await runTool(
      editTool,
      { path: "a.ts", edits: [{ range: [first!, first!], lines: ["one"] }] },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No changes made.");
    const metrics = result.details?.metrics as
      Record<string, unknown> | undefined;
    expect(metrics?.classification).toBe("noop");
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe(before);
  });

  it("rejects edits that would empty the file (spec §22)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const keys = [...anchors.values()];
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [keys[0]!, keys[1]!], lines: [] }] },
        dir,
      ),
    ).rejects.toThrow(/E_WOULD_EMPTY/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("fails with E_ANCHOR_STALE for anchors that no longer resolve", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const [first] = [...anchors.values()];
    // External change removes the anchor line entirely.
    writeFileAt(dir, "a.ts", "ONE\ntwo\nthree\n");
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [first!, first!], lines: ["x"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_STALE/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("ONE\ntwo\nthree\n");
  });

  it("classifies never-allocated anchors as E_ANCHOR_NOT_SERVED, not stale", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    // "Zz9z" was never shown for this file — a constructed anchor, and the
    // file is untouched, so the failure must NOT claim a content change.
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: ["Zz9z", "Zz9z"], lines: ["x"] }] },
        dir,
      ),
    ).rejects.toThrow(/E_ANCHOR_NOT_SERVED[\s\S]*never allocated/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("suggests the unique case-insensitive near-match for typos", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const [first] = [...anchors.values()];
    const typo = first!.replace(/[A-Za-z]/, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    await expect(
      runTool(
        editTool,
        { path: "a.ts", edits: [{ range: [typo, typo], lines: ["x"] }] },
        dir,
      ),
    ).rejects.toThrow(new RegExp(`Did you mean "${first}"`));
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\n");
  });

  it("enforces expected_revision CAS mode (spec §27)", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const revision = (read.details as { revision?: string })?.revision;
    expect(revision).toBeTypeOf("string");
    const anchors = anchorsFromRead(textOf(read));
    const [first] = [...anchors.values()];

    // External modification invalidates the revision.
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    await expect(
      runTool(
        editTool,
        {
          path: "a.ts",
          edits: [{ range: [first!, first!], lines: ["ONE"] }],
          expected_revision: revision,
        },
        dir,
      ),
    ).rejects.toThrow(/E_FILE_REVISION_CHANGED/);
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\ntwo\nthree\n");
  });

  // POSIX permission bits do not exist on Windows (mode is always 0o666).
  it.skipIf(process.platform === "win32")("preserves BOM, CRLF, and mode across edits", async () => {
    const dir = makeProject();
    const path = writeFileAt(dir, "a.ts", "\uFEFFone\r\ntwo\r\nthree\r\n");
    require("fs").chmodSync(path, 0o754);
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [anchors.get("two")!, anchors.get("two")!],
            lines: ["TWO", "two.5"],
          },
        ],
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe(
      "\uFEFFone\r\nTWO\r\ntwo.5\r\nthree\r\n",
    );
    const mode = require("fs").statSync(path).mode & 0o777;
    expect(mode).toBe(0o754);
  });

  it("serves diff context rows for follow-up edits", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    await runTool(readTool, { path: "a.ts" }, dir);
    const r = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [
          {
            range: [
              anchorOf(await readOnce(dir, "a.ts"), "two")!,
              anchorOf(await readOnce(dir, "a.ts"), "two")!,
            ],
            lines: ["TWO"],
          },
        ],
      },
      dir,
    );
    expect(r.isError).toBeFalsy();
    // The unchanged context row for "one" carries an anchor that was served
    // by the diff; editing it directly must succeed.
    const contextRow = textOf(r)
      .split("\n")
      .find((l) => /^ [A-Za-z0-9]{4}│one$/.test(l));
    const contextAnchor = contextRow?.match(/^ ([A-Za-z0-9]{4})│/)?.[1];
    expect(contextAnchor).toBeDefined();
    const r2 = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [contextAnchor!, contextAnchor!], lines: ["ONE"] }],
      },
      dir,
    );
    expect(r2.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("ONE\nTWO\nthree\n");
  });
});

function anchorOf(text: string, content: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z0-9]{4})│(.*)$/);
    if (match && match[2] === content) return match[1];
  }
  return undefined;
}

async function readOnce(dir: string, name: string): Promise<string> {
  const result = await runTool(readTool, { path: name }, dir);
  return textOf(result);
}

function joinPath(dir: string, name: string): string {
  return require("path").join(dir, name);
}

describe("edit tool option warnings", () => {
  it("warns when final_newline does not reach EOF", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\nthree\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const one = anchors.get("one")!;
    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [one, one], lines: ["ONE"] }],
        final_newline: "absent",
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("[W_UNUSED_OPTION]");
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("ONE\ntwo\nthree\n");
  });

  it("applies final_newline at EOF edits", async () => {
    const dir = makeProject();
    writeFileAt(dir, "a.ts", "one\ntwo\n");
    const read = await runTool(readTool, { path: "a.ts" }, dir);
    const anchors = anchorsFromRead(textOf(read));
    const two = anchors.get("two")!;
    const result = await runTool(
      editTool,
      {
        path: "a.ts",
        edits: [{ range: [two, two], lines: ["TWO"] }],
        final_newline: "absent",
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileAt(joinPath(dir, "a.ts"))).toBe("one\nTWO");
  });
});

describe("large edit guard configuration", () => {
  it("allows reading and updating the guard thresholds", () => {
    const initial = getLargeEditGuard();
    expect(initial.minRemovedLines).toBe(20);
    expect(initial.removedRatio).toBe(3);
    setLargeEditGuard({ minRemovedLines: 30 });
    expect(getLargeEditGuard().minRemovedLines).toBe(30);
    setLargeEditGuard({ minRemovedLines: 20 });
    expect(getLargeEditGuard().minRemovedLines).toBe(20);
    expect(() => setLargeEditGuard({ minRemovedLines: 0 })).toThrow(
      /E_BAD_SHAPE/,
    );
    expect(() => setLargeEditGuard({ removedRatio: Number.NaN })).toThrow(
      /E_BAD_SHAPE/,
    );
  });
});
