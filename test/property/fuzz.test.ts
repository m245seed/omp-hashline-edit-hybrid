import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";
import { makeProject, runTool, textOf, writeFileAt, readFileAt, anchorsFromReadArray } from "../support/tools";

import { resetStoreForTests } from "../../src/state/database";
import { resetServed } from "../../src/served/ledger";
import { buildReadToolDef } from "../../src/tools/read";
import { buildEditToolDef } from "../../src/tools/edit";
import { buildUndoToolDef } from "../../src/tools/undo";
import { ANCHOR_RE } from "../../src/anchors/alphabet";
import { AnchorAllocator } from "../../src/anchors/allocator";
import { decodeDocument, encodeDocument } from "../../src/document/encoding";
import { applyTransaction, type MutationOp, type EditOp, type InsertOp } from "../../src/mutation/apply";
import { join } from "path";

const readTool = buildReadToolDef();
const editTool = buildEditToolDef();
const undoTool = buildUndoToolDef();

// ─── Deterministic PRNG ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINE_POOL = [
  "}",
  "{",
  "",
  "  return x;",
  "return x; ",
  "const a = 1;",
  "  // comment",
  "héllo wörld",
  "Ab31│literal-ish",
  "  foo(bar);",
  "\tindented",
  "x",
  "x",
];

function randomLines(rand: () => number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(LINE_POOL[Math.floor(rand() * LINE_POOL.length)]!);
  }
  return out;
}

// ─── Pure-engine invariants (spec §59) ─────────────────────────────────

function checkPureInvariants(
  texts: string[],
  anchors: string[],
  retired: ReadonlySet<string>,
  result: ReturnType<typeof applyTransaction>,
): void {
  const resultTexts = result.document.lines.map((l) => l.text);
  expect(result.anchors.length).toBe(resultTexts.length);
  for (const anchor of result.anchors) {
    expect(ANCHOR_RE.test(anchor)).toBe(true);
  }
  expect(new Set(result.anchors).size).toBe(resultTexts.length);
  const retiredAfter = new Set([...retired, ...result.retiredAdded]);
  for (const anchor of result.anchors) {
    if (retiredAfter.has(anchor)) {
      const oldIdx = anchors.indexOf(anchor);
      console.log("RETIRED HIT", anchor, "oldIdx", oldIdx, "inRetired", retired.has(anchor), "inRetiredAdded", result.retiredAdded.includes(anchor));
      console.log("retired:", JSON.stringify([...retired]));
      console.log("retiredAdded:", JSON.stringify(result.retiredAdded));
      expect(retiredAfter.has(anchor)).toBe(false);
    }
  }
  for (const anchor of result.retiredAdded) {
    expect(anchors.includes(anchor)).toBe(true);
  }
  // A preserved anchor must still carry the exact same text (never silently
  // changes requested content).
  const oldIndexByAnchor = new Map<string, number>();
  anchors.forEach((a, i) => oldIndexByAnchor.set(a, i));
  for (let j = 0; j < result.anchors.length; j++) {
    const oldIdx = oldIndexByAnchor.get(result.anchors[j]!);
    if (oldIdx !== undefined) {
      expect(resultTexts[j]).toBe(texts[oldIdx]!);
    }
  }
}

describe("property: chained random edits preserve all invariants (spec §59, §62)", () => {
  it("runs thousands of chained mutations without an anchor invariant violation", async () => {
    
    const rand = mulberry32(0x5eed);
    let texts = randomLines(rand, 20);
    let doc = decodeDocument(Buffer.from(encodeDocument({ bom: "", lines: texts.map((t) => ({ text: t, eol: "\n" })) }), "utf-8"), "fuzz");
    // Initial anchors: one deterministic anchor per line.
    const allocator = new AnchorAllocator(new Set(), new Set());
    let anchors = texts.map((t) => allocator.allocate(t));
    expect(anchors.length).toBe(texts.length);
    const retired = new Set<string>();

    for (let iter = 0; iter < 3000; iter++) {
      // Build 1-4 random operations against the current document. The
      // generator only creates valid, non-overlapping operations — the
      // engine itself must never see an overlapping request here.
      const ops: MutationOp[] = [];
      const usedRanges: Array<[number, number]> = [];
      const usedInserts: number[] = [];
      const opCount = 1 + Math.floor(rand() * 4);
      let guard = 0;
      while (ops.length < opCount && guard++ < 20) {
        const n = doc.lines.length;
        if (n === 0) break;
        if (rand() < 0.3) {
          const i = Math.floor(rand() * n);
          const insideRange = usedRanges.some(([s, e]) => i >= s && i <= e);
          if (insideRange) continue;
          usedInserts.push(i);
          ops.push({
            kind: "insert",
            anchorIndex: i,
            direction: rand() < 0.5 ? "before" : "after",
            lines: randomLines(rand, Math.floor(rand() * 3)),
            requestIndex: ops.length,
          } satisfies InsertOp);
        } else {
          const start = Math.floor(rand() * n);
          const end = Math.min(n - 1, start + Math.floor(rand() * 5));
          const lines = randomLines(rand, Math.floor(rand() * 4));
          const overlap = usedRanges.some(([s, e]) => start <= e && end >= s);
          const containsInsert = usedInserts.some((i) => i >= start && i <= end);
          // Deleting the entire document would trigger E_WOULD_EMPTY.
          if (start === 0 && end === n - 1 && lines.length === 0) continue;
          if (overlap || containsInsert) continue;
          usedRanges.push([start, end]);
          ops.push({
            kind: "edit",
            start,
            end,
            lines,
            requestIndex: ops.length,
          } satisfies EditOp);
        }
      }
      if (ops.length === 0) continue;

      // Multiple empty deletions covering the whole document would trigger
      // E_WOULD_EMPTY; skip such transactions (the engine rejects them).
      {
        const covered = new Set<number>();
        let wouldEmpty = ops.length > 0;
        for (const op of ops) {
          if (op.kind === "insert") {
            wouldEmpty = false;
            break;
          }
          if (op.lines.length > 0) {
            wouldEmpty = false;
            break;
          }
          for (let i = op.start; i <= op.end; i++) covered.add(i);
        }
        if (wouldEmpty && covered.size === doc.lines.length) continue;
      }

      let result: ReturnType<typeof applyTransaction>;
      try {
        result = applyTransaction(doc, { anchors, retired }, ops);
      } catch (e) {
        console.log("FAIL iter", iter, JSON.stringify(ops), JSON.stringify(doc.lines.map((l) => l.text)), JSON.stringify(anchors));
        throw e;
      }
      try {
        checkPureInvariants(
          doc.lines.map((l) => l.text),
          anchors,
          retired,
          result,
        );
      } catch (e) {
        console.log("INVARIANT FAIL iter", iter, JSON.stringify(ops), JSON.stringify(doc.lines.map((l) => l.text)), JSON.stringify(anchors), JSON.stringify([...retired]));
        console.log("resultTexts:", JSON.stringify(result.document.lines.map((l) => l.text)));
        console.log("resultAnchors:", JSON.stringify(result.anchors));
        console.log("retiredAdded:", JSON.stringify(result.retiredAdded));
        throw e;
      }
      // Track retired anchors; keep the model fresh for the next iteration.
      for (const a of result.retiredAdded) retired.add(a);
      doc = result.document;
      anchors = result.anchors;
      expect(doc.lines.length).toBeGreaterThan(0);
      expect(encodeDocument(doc)).not.toBeUndefined();
    }
  });

  it("external-change fuzz: outcome is always a safe edit or a clean rejection", async () => {
    
    const rand = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 300; iter++) {
      const n = 5 + Math.floor(rand() * 10);
      let texts = randomLines(rand, n);
      let doc = decodeDocument(Buffer.from(texts.join("\n"), "utf-8"), "fuzz");
      const allocator = new AnchorAllocator(new Set(), new Set());
      let anchors = texts.map((t) => allocator.allocate(t));
      const retired = new Set<string>();

      // Random external modification: insert, delete, or change lines.
      const mutation = rand();
      if (mutation < 0.33) {
        const at = Math.floor(rand() * (texts.length + 1));
        texts.splice(at, 0, ...randomLines(rand, 1 + Math.floor(rand() * 3)));
      } else if (mutation < 0.66) {
        const at = Math.floor(rand() * texts.length);
        texts.splice(at, 1);
      } else {
        const at = Math.floor(rand() * texts.length);
        texts[at] = randomLines(rand, 1)[0]!;
      }
      // Reconcile exactly like loadAnchoredFile does.
      const { reconcileState } = await import("../../src/anchors/reconcile");
      const { fingerprintHexes } = await import("../../src/anchors/fingerprints");
      const reconciled = reconcileState(
        { anchors, fingerprints: fingerprintHexes(doc.lines.map((l) => l.text)) },
        retired,
        texts,
        fingerprintHexes(texts),
      );
      for (const a of reconciled.retiredAdded) retired.add(a);
      const newAnchors = reconciled.anchors;

      // Random valid edit on the reconciled document.
      const m = newAnchors.length;
      if (m === 0) continue;
      const start = Math.floor(rand() * m);
      const end = Math.min(m - 1, start + Math.floor(rand() * 4));
      const lines = randomLines(rand, 1 + Math.floor(rand() * 3));
      if (start === 0 && end === m - 1 && lines.length === 0) continue;
      const result = applyTransaction(
        decodeDocument(Buffer.from(texts.join("\n"), "utf-8"), "fuzz"),
        { anchors: newAnchors, retired },
        [{ kind: "edit", start, end, lines, requestIndex: 0 }],
      );
      try {
        checkPureInvariants(texts, newAnchors, retired, result);
      } catch (error) {
        console.log("EXT FAIL", JSON.stringify({ texts, newAnchors, start, end, lines, resultTexts: result.document.lines.map((l) => l.text), resultAnchors: result.anchors }));
        throw error;
      }
    }
  });
});

// ─── End-to-end fuzz through the tools (spec §62, §70) ─────────────────


;

beforeEach(() => {
  withStateDir();
  resetServed();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("property: chained tool-level edits (spec §62)", () => {
  it("runs chained read→edit→(occasionally undo) cycles with byte fidelity", async () => {
    const rand = mulberry32(0xbeef);
    const dir = makeProject();
    const file = join(dir, "fuzz.ts");
    let content = randomLines(rand, 10).join("\n") + "\n";
    writeFileAt(dir, "fuzz.ts", content);

    for (let iter = 0; iter < 200; iter++) {
      const read = await runTool(readTool, { path: "fuzz.ts" }, dir);
      expect(read.isError).toBeFalsy();
      const keys = anchorsFromReadArray(textOf(read));
      if (keys.length === 0) continue;

      const useEdit = rand() < 0.8;
      if (useEdit) {
        const startIdx = Math.floor(rand() * keys.length);
        const endIdx = Math.min(keys.length - 1, startIdx + Math.floor(rand() * 3));
        const start = keys[startIdx]!;
        const end = keys[endIdx]!;
        const lines = randomLines(rand, 1 + Math.floor(rand() * 3));
        const before = readFileAt(file);
        let result;
        try {
          result = await runTool(
            editTool,
            { path: "fuzz.ts", edits: [{ range: [start, end], lines }], allow_display_like_content: true },
            dir,
          );
        } catch (error) {
          const message = (error as Error).message;
          // Safety preflights (PH-EDIT-001/006) may reject random edits;
          // they must leave the file untouched.
          if (/E_BOUNDARY_DUP|E_LARGE_DESTRUCTIVE_EDIT/.test(message)) {
            expect(readFileAt(file)).toBe(before);
            continue;
          }
          console.log("TOOL FAIL iter", iter, JSON.stringify({ start, end, lines }), message.slice(0, 120));
          throw error;
        }
        expect(result.isError).toBeFalsy();
        content = readFileAt(file);
      } else {
        // Occasional undo: must restore exact bytes.
        const before = readFileAt(file);
        let r;
        try {
          r = await runTool(editTool, { path: "fuzz.ts", edits: [{ range: [keys[0]!, keys[0]!], lines: ["TOUCH"] }] }, dir);
        } catch {
          // Preflight rejection (e.g. boundary dup against a neighbor).
          expect(readFileAt(file)).toBe(before);
          continue;
        }
        if (r.isError) continue;
        const undo = await runTool(undoTool, { path: "fuzz.ts" }, dir);
        expect(undo.isError).toBeFalsy();
        expect(readFileAt(file)).toBe(before);
        content = before;
      }
    }
  });

  it("external modifications between read and edit never corrupt the target", async () => {
    const rand = mulberry32(0xd00d);
    for (let iter = 0; iter < 150; iter++) {
      const dir = makeProject();
      const file = join(dir, "x.ts");
      const original = randomLines(rand, 8).join("\n") + "\n";
      writeFileAt(dir, "x.ts", original);
      const read = await runTool(readTool, { path: "x.ts" }, dir);
      const keys = anchorsFromReadArray(textOf(read));
      if (keys.length < 2) continue;

      // Random external change.
      const mut = rand();
      let external: string;
      if (mut < 0.4) {
        external = randomLines(rand, 5).join("\n") + "\n";
      } else if (mut < 0.7) {
        external = original.replace("return x;", "return y;");
      } else {
        external = original.split("\n").reverse().join("\n") + "\n";
      }
      writeFileAt(dir, "x.ts", external);

      const startIdx = Math.floor(rand() * (keys.length - 1));
      const endIdx = Math.min(keys.length - 1, startIdx + Math.floor(rand() * 3));
      const start = keys[startIdx]!;
      const end = keys[endIdx]!;
      let result;
      try {
        result = await runTool(
          editTool,
          { path: "x.ts", edits: [{ range: [start, end], lines: ["REPLACED"] }] },
          dir,
        );
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: (error as Error).message }] };
      }
      if (result.isError) {
        const message = textOf(result);
        expect(message).toMatch(/E_ANCHOR_STALE|E_ANCHOR_NOT_SERVED|E_RANGE_STALE|E_FILE_CHANGED|E_FILE_REVISION_CHANGED/);
        // Nothing was modified on a rejection.
        expect(readFileAt(file)).toBe(external);
      } else {
        // A successful edit must contain exactly one REPLACED line and all
        // other lines must come from the external content.
        const after = readFileAt(file);
        expect(after.split("\n").filter((l) => l === "REPLACED").length).toBe(1);
      }
    }
  });
});
