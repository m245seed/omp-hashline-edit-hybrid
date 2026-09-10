/**
 * `grep` tool (spec §24).
 *
 * Searches with ripgrep when available and renders matches with anchors
 * from the same persistent anchor engine as `read` — never independently
 * fabricated context hashes. Full match and context lines are marked
 * served, so the workflow is `grep → edit` without a redundant read.
 * Supports literal/regex search, file or directory roots, include/exclude
 * globbing, before/after context, and a bounded result count.
 */

import { stat as fsStat } from "fs/promises";
import { createInterface } from "readline";
import { spawn, spawnSync } from "child_process";
import type { Stats } from "fs";
import { existsSync } from "fs";
import { homedir } from "os";
import { relative, basename, join } from "path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf, isRec, rejectUnknownFields } from "../utils";
import {
  resolveTarget,
  withFileMutationQueue,
} from "../filesystem/resolve-target";
import type { AnchoredFile } from "../mutation/transaction";
import { loadAnchoredFile } from "../mutation/transaction";
import { renderLinesUnserved } from "../render/engine";
import { serveLines, servedWindowNotice } from "../served/ledger";
import { hashlineDetails } from "../render/result-details";
import { HASHLINE_PROTOCOL_ID } from "../constants";
const GREP_ROOT_KEYS = new Set([
  "pattern",
  "path",
  "glob",
  "ignoreCase",
  "literal",
  "context",
  "limit",
]);

export interface GrepToolDetails {
  matches: number;
  files: number;
  hashline: ReturnType<typeof hashlineDetails>;
}

const grepSchema = Type.Object(
  {
    pattern: Type.String({ description: "Search pattern (regex or literal)" }),
    path: Type.Optional(
      Type.String({
        description: "File or directory to search (default: cwd)",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        description: "File filter glob, e.g. '*.ts' or '**/*.spec.ts'",
      }),
    ),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  {
    additionalProperties: false,
  },
);

const G_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Search files with ripgrep and return matching lines with stable 4-character anchors (same engine as read), so results can drive edit/insert directly. Match lines and context lines are fully shown and become authorized for destructive edits.`;

const G_SNIPPET =
  "grep: anchored search; match and context lines carry edit-ready anchors, enabling grep → edit without a separate read.";

const DEFAULT_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;

function findRgPath(): string | null {
  const piBin = join(homedir(), ".pi", "bin");
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  if (existsSync(join(piBin, rgName))) return join(piBin, rgName);
  try {
    const result = spawnSync("rg", ["--version"], { stdio: "pipe" });
    if (result.status === 0) return "rg";
  } catch {}
  return null;
}

const rgPath: string | null = findRgPath();

interface LineEntry {
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

export function buildGrepToolDef(): ToolDefinition<any, GrepToolDetails> {
  return {
    name: "grep",
    label: "Grep",
    description: G_DESC,
    promptSnippet: G_SNIPPET,
    parameters: grepSchema,
    executionMode: "parallel",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      if (!isRec(params)) {
        throw new Error("[E_BAD_SHAPE] grep parameters must be an object.");
      }
      rejectUnknownFields(params, GREP_ROOT_KEYS, "grep request");
      const pattern = params?.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error(
          '[E_BAD_SHAPE] A non-empty "pattern" string is required.',
        );
      }
      if (pattern.includes("\0")) {
        throw new Error('[E_BAD_SHAPE] "pattern" must not contain a NUL byte.');
      }
      if (params?.glob !== undefined && typeof params.glob !== "string") {
        throw new Error('[E_BAD_SHAPE] "glob" must be a string.');
      }
      if (typeof params?.glob === "string" && params.glob.includes("\0")) {
        throw new Error('[E_BAD_SHAPE] "glob" must not contain a NUL byte.');
      }
      if (
        params?.path !== undefined &&
        (typeof params.path !== "string" || params.path.length === 0)
      ) {
        throw new Error('[E_BAD_SHAPE] "path" must be a non-empty string.');
      }
      if (typeof params?.path === "string" && params.path.includes("\0")) {
        throw new Error('[E_BAD_SHAPE] "path" must not contain a NUL byte.');
      }
      if (
        params?.ignoreCase !== undefined &&
        typeof params.ignoreCase !== "boolean"
      ) {
        throw new Error('[E_BAD_SHAPE] "ignoreCase" must be a boolean.');
      }
      if (
        params?.literal !== undefined &&
        typeof params.literal !== "boolean"
      ) {
        throw new Error('[E_BAD_SHAPE] "literal" must be a boolean.');
      }
      if (
        params?.context !== undefined &&
        (!Number.isInteger(params.context) || (params.context as number) < 0)
      ) {
        throw new Error(
          '[E_BAD_SHAPE] "context" must be a non-negative integer.',
        );
      }
      if (
        params?.limit !== undefined &&
        (!Number.isInteger(params.limit) || (params.limit as number) < 1)
      ) {
        throw new Error('[E_BAD_SHAPE] "limit" must be a positive integer.');
      }
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const context =
        (params.context as number | undefined) && (params.context as number) > 0
          ? (params.context as number)
          : 0;
      const limit = Math.max(
        1,
        (params.limit as number | undefined) ?? DEFAULT_LIMIT,
      );
      const searchDirRaw =
        params.path && typeof params.path === "string" ? params.path : ".";
      const searchPath = toCwd(searchDirRaw, ctx.cwd);

      abortIf(signal);
      if (!rgPath) {
        throw new Error(
          "ripgrep (rg) is not available. Install it: https://github.com/BurntSushi/ripgrep",
        );
      }
      let isDirectory: boolean;
      let searchInfo: Stats;
      try {
        searchInfo = await fsStat(searchPath);
      } catch {
        throw new Error(
          `[E_BAD_REF] Path not found: ${searchPath}. Verify the path; grep accepts one existing file or directory. Use glob() to discover paths.`,
        );
      }
      if (!searchInfo.isDirectory() && !searchInfo.isFile()) {
        throw new Error(
          `[E_BAD_REF] Path is not a regular file or directory: ${searchPath}`,
        );
      }
      isDirectory = searchInfo.isDirectory();

      const fileEntries = await runRipgrep({
        rgPath,
        pattern,
        searchPath,
        glob: params.glob as string | undefined,
        ignoreCase,
        literal,
        context,
        limit,
        signal,
      });

      const outputLines: string[] = [];
      const notices: string[] = [];
      let totalMatches = 0;
      let fileCount = 0;
      let skippedFiles = 0;
      let crOnlyFiles = 0;
      let servedRowCount = 0;
      // Rows are rendered unserved and only committed to the served ledger
      // once they survive the output budget — a line becomes served only
      // when the model actually receives its complete contents.
      let budget = MAX_OUTPUT_BYTES;
      let truncated = false;
      const pushLine = (line: string): boolean => {
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        if (lineBytes > budget) {
          truncated = true;
          return false;
        }
        budget -= lineBytes;
        outputLines.push(line);
        return true;
      };
      let evictedRows = 0;
      for (const [filePath, entries] of fileEntries) {
        if (!entries.length) continue;
        entries.sort((a, b) => a.lineNumber - b.lineNumber);
        let realPath: string;
        try {
          realPath = await resolveTarget(filePath);
        } catch {
          skippedFiles++;
          continue;
        }
        const result = await withFileMutationQueue(realPath, async () => {
          let file: AnchoredFile;
          try {
            file = await loadAnchoredFile(realPath, filePath);
          } catch {
            return { skipped: true, stop: false, evictedRows: 0 };
          }

          const matchNums = entries
            .filter((e) => e.isMatch)
            .map((e) => e.lineNumber);
          totalMatches += matchNums.length;
          fileCount++;

          const displayPath = isDirectory
            ? (relative(searchPath, filePath) || basename(filePath)).replace(
                /\\/g,
                "/",
              )
            : basename(filePath);
          const pendingForFile: Array<{ anchor: string; exactText: string }> =
            [];
          const pushFileRow = (
            anchor: string,
            exactText: string,
            row: string,
          ): boolean => {
            if (!pushLine(row)) return false;
            pendingForFile.push({ anchor, exactText });
            return true;
          };

          // ripgrep counts only \n (and \r\n) as line breaks; the hybrid
          // document model also splits on lone \r. In CR-only files the line
          // numbers cannot be aligned, so no anchors are shown for them.
          const hasCrOnlyEndings = file.doc.lines.some(
            (line) => line.eol === "\r",
          );
          if (hasCrOnlyEndings) {
            crOnlyFiles++;
            const complete =
              pushLine(`\n${displayPath}`) &&
              pushLine(
                `[Line anchors unavailable: this file uses CR-only line endings, which cannot be aligned with ripgrep line numbers. ${matchNums.length} match(es) found. Use read to view and edit this file.]`,
              );
            return { skipped: false, stop: !complete, evictedRows: 0 };
          }

          if (!pushLine(`\n${displayPath}`)) {
            return { skipped: false, stop: true, evictedRows: 0 };
          }
          let stopped = false;
          // Batch contiguous line numbers into single renderLinesUnserved calls
          // to avoid per-line allocation and repeated Buffer.byteLength.
          let i = 0;
          while (i < entries.length) {
            const startLine = entries[i]!.lineNumber;
            let endLine = startLine;
            let j = i + 1;
            while (
              j < entries.length &&
              entries[j]!.lineNumber === entries[j - 1]!.lineNumber + 1
            ) {
              endLine = entries[j]!.lineNumber;
              j++;
            }
            const startIdx = startLine - 1;
            const endIdx = endLine; // exclusive, 1-indexed endLine -> 0-indexed exclusive
            if (startIdx >= 0 && startIdx < file.texts.length) {
              const clampedEnd = Math.min(endIdx, file.texts.length);
              if (clampedEnd > startIdx) {
                const { rows, served } = renderLinesUnserved(
                  file.anchors,
                  file.texts,
                  startIdx,
                  clampedEnd,
                );
                let servedIdx = 0;
                for (const row of rows) {
                  // Omitted rows start with "[Line" and have no served entry
                  const isOmitted = row.startsWith("[Line ");
                  if (isOmitted) {
                    if (!pushLine(row)) {
                      stopped = true;
                      break;
                    }
                  } else {
                    const entry = served[servedIdx++];
                    if (entry) {
                      if (!pushFileRow(entry.anchor, entry.exactText, row)) {
                        stopped = true;
                        break;
                      }
                    } else if (!pushLine(row)) {
                      stopped = true;
                      break;
                    }
                  }
                }
              }
            }
            if (stopped) break;
            i = j;
          }

          // Keep loading, rendering, and authorizing under one per-file queue
          // entry; otherwise a concurrent write can authorize stale text.
          const rowsEvicted =
            pendingForFile.length > 0
              ? serveLines(realPath, pendingForFile)
              : 0;
          servedRowCount += pendingForFile.length;
          return { skipped: false, stop: stopped, evictedRows: rowsEvicted };
        });
        if (result.skipped) {
          skippedFiles++;
          continue;
        }
        evictedRows += result.evictedRows;
        if (result.stop) break;
      }

      while (
        outputLines.length > 0 &&
        outputLines[outputLines.length - 1] === ""
      ) {
        outputLines.pop();
      }
      let output = outputLines.join("\n");
      if (evictedRows > 0) {
        output += servedWindowNotice(evictedRows);
      }
      if (!output && skippedFiles === 0) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            matches: totalMatches,
            files: fileCount,
            hashline: hashlineDetails({
              outcome: "no_match",
              code: "NO_MATCH",
              servedRows: 0,
            }),
          },
        };
      }
      if (truncated) {
        notices.push(
          `${MAX_OUTPUT_BYTES / 1024}KB output limit reached; later rows were cut before serving`,
        );
      }
      if (skippedFiles > 0) {
        notices.push(
          `${skippedFiles} file(s) skipped: not readable as anchored text (binary, non-UTF-8, or oversized)`,
        );
      }
      if (crOnlyFiles > 0) {
        notices.push(
          `${crOnlyFiles} file(s) use CR-only line endings; no anchors shown for them`,
        );
      }
      if (totalMatches >= limit) {
        notices.push(
          `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine the pattern.`,
        );
      }
      if (notices.length > 0) {
        output += `${output ? "\n\n" : ""}[${notices.join(". ")}]`;
      }
      return {
        content: [{ type: "text", text: output }],
        details: {
          matches: totalMatches,
          files: fileCount,
          hashline: hashlineDetails({
            outcome: totalMatches > 0 ? "success" : "no_match",
            code: totalMatches > 0 ? "OK" : "NO_MATCH",
            servedRows: servedRowCount,
          }),
        },
      };
    },
  } as ToolDefinition<any, GrepToolDetails>;
}

interface RunOptions {
  rgPath: string;
  pattern: string;
  searchPath: string;
  glob?: string;
  ignoreCase: boolean;
  literal: boolean;
  context: number;
  limit: number;
  signal?: AbortSignal;
}

function runRipgrep(options: RunOptions): Promise<Map<string, LineEntry[]>> {
  const {
    rgPath: rgExe,
    pattern,
    searchPath,
    glob,
    ignoreCase,
    literal,
    context,
    limit,
    signal,
  } = options;
  return new Promise((resolveFn, rejectFn) => {
    if (signal?.aborted) {
      rejectFn(new Error("[E_ABORTED] Operation aborted."));
      return;
    }
    const args: string[] = [
      "--json",
      "--line-number",
      "--color=never",
      "--hidden",
    ];
    if (ignoreCase) args.push("--ignore-case");
    if (literal) args.push("--fixed-strings");
    if (glob) args.push("--glob", glob);
    if (context > 0) args.push("--context", String(context));
    args.push("--", pattern, searchPath);

    const child = spawn(rgExe, args, { stdio: ["ignore", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    let killedDueToLimit = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const stopChild = (): void => {
      if (!child.killed) {
        killedDueToLimit = true;
        child.kill();
      }
    };
    const onAbort = (): void => {
      stopChild();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const fileEntries = new Map<string, LineEntry[]>();
    // O(1) lookup per line number to replace prior O(N) entries.find
    const fileEntryMaps = new Map<string, Map<number, LineEntry>>();
    let currentFile = "";
    let isFirstLine = true;
    // Ripgrep can emit buffered match events after the child is killed. Count
    // each file/line once and ignore later distinct matches after the cap.
    const matchedLines = new Set<string>();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    rl.on("line", (raw) => {
      if (!raw.trim()) return;
      let event: {
        type: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        return;
      }
      if (event.type === "begin") {
        currentFile = event.data?.path?.text ?? "";
        fileEntries.set(currentFile, []);
        fileEntryMaps.set(currentFile, new Map());
        isFirstLine = true;
      } else if (event.type === "match" || event.type === "context") {
        const num = event.data?.line_number;
        const text = event.data?.lines?.text;
        if (
          typeof num !== "number" ||
          !Number.isInteger(num) ||
          num < 1 ||
          typeof text !== "string"
        )
          return;
        const noBom =
          isFirstLine && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        isFirstLine = false;
        // ripgrep includes the physical line terminator in JSON `lines.text`.
        // Remove both bytes of CRLF so the served text matches the document
        // model exactly (which stores terminators separately).
        let normalized = noBom.endsWith("\n") ? noBom.slice(0, -1) : noBom;
        if (normalized.endsWith("\r")) normalized = normalized.slice(0, -1);
        const entries = fileEntries.get(currentFile);
        const entryMap = fileEntryMaps.get(currentFile);
        if (!entries || !entryMap) return;
        const matchKey = `${currentFile}\u0000${num}`;
        if (event.type === "match" && !matchedLines.has(matchKey)) {
          // A killed child may still drain already-buffered stdout. Do not
          // admit a new match line once the requested cap has been reached.
          if (matchedLines.size >= limit) return;
          matchedLines.add(matchKey);
        }
        const existing = entryMap.get(num);
        const isMatch = event.type === "match" || (existing?.isMatch ?? false);
        if (existing) {
          existing.isMatch = isMatch;
        } else {
          const entry: LineEntry = {
            lineNumber: num,
            text: normalized,
            isMatch,
          };
          entries.push(entry);
          entryMap.set(num, entry);
        }
        if (event.type === "match" && matchedLines.size >= limit) {
          stopChild();
        }
      }
    });
    child.on("error", (error) => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      settle(() =>
        rejectFn(new Error(`Failed to run ripgrep: ${error.message}`)),
      );
    });

    child.on("close", () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        settle(() => rejectFn(new Error("[E_ABORTED] Operation aborted.")));
        return;
      }
      if (!killedDueToLimit && child.exitCode !== 0 && child.exitCode !== 1) {
        settle(() =>
          rejectFn(
            new Error(
              stderr.trim() || `ripgrep exited with code ${child.exitCode}`,
            ),
          ),
        );
        return;
      }

      // A killed ripgrep process may still have emitted buffered context
      // records for matches that were beyond the requested match limit. Keep
      // only admitted match rows and contexts within the requested distance
      // of those matches. This also handles overlapping contexts naturally.
      const filteredEntries = new Map<string, LineEntry[]>();
      for (const [file, entries] of fileEntries) {
        const admittedMatches = entries
          .filter((entry) => entry.isMatch)
          .map((entry) => entry.lineNumber);
        if (admittedMatches.length === 0) continue;
        const retainedLines = new Set<number>();
        for (const lineNumber of admittedMatches) {
          const first = Math.max(1, lineNumber - context);
          const last = lineNumber + context;
          for (let line = first; line <= last; line++) retainedLines.add(line);
        }
        filteredEntries.set(
          file,
          entries.filter(
            (entry) => entry.isMatch || retainedLines.has(entry.lineNumber),
          ),
        );
      }
      settle(() => resolveFn(filteredEntries));
    });
  });
}
