/**
 * `undo` tool (spec §32–§36, PH-PROTO-001..003, PH-CONTEXT-005).
 *
 * Reverts the last successful hybrid transaction on one file (all sub-edits
 * together). Precondition: the file's current checksum must exactly match
 * the previous transaction's result — otherwise E_UNDO_STALE and nothing is
 * modified, so undo never overwrites later work. Restores exact previous
 * bytes (BOM, CRLF/CR/LF, final newline, trailing whitespace) and exact
 * previous anchors: anchors present before the transaction return exactly;
 */
import { toCwd } from "../paths";
import { readFile } from "fs/promises";
import { HASHLINE_PROTOCOL_ID } from "../constants";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import {
  abortIf,
  errCode,
  isRec,
  rejectUnknownFields,
  sha256Hex,
} from "../utils";
import { withFileMutationQueue } from "../filesystem/resolve-target";
import {
  resolveMutationTarget,
  buildMutationMetrics,
  renderAndServeDiffRows,
} from "./shared";
import { loadStore } from "../state/database";
import { getUndoRecord } from "../state/undo";
import { decodeDocument } from "../document/encoding";
import { assertPath } from "../mutation/validate";
import { buildDiffRows } from "../mutation/apply";
import { commitMutation } from "../mutation/transaction";
import { newTransactionId } from "../state/transaction-journal";
import { hashlineDetails } from "../render/result-details";
import type { MutationMetrics } from "./shared";
const UNDO_ROOT_KEYS = new Set(["path"]);

export interface UndoToolDetails {
  diff?: string;
  metrics?: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

const undoSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to undo" }),
  },
  {
    additionalProperties: false,
  },
);

const U_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Revert the last successful hybrid transaction on one file — if one call changed five ranges, undo restores all five together. The file must still match the state produced by that transaction; if it was modified afterwards, undo fails without overwriting anything. Undo restores exact bytes and exact anchors.`;

const U_SNIPPET =
  "undo: revert the last hybrid transaction on a file; fails (E_UNDO_STALE) if the file changed since, so it never destroys later work.";

export function buildUndoToolDef(): ToolDefinition<any, UndoToolDetails> {
  return {
    name: "undo",
    label: "Undo",
    description: U_DESC,
    promptSnippet: U_SNIPPET,
    parameters: undoSchema,
    executionMode: "sequential",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      if (!isRec(params)) {
        throw new Error("[E_BAD_SHAPE] undo parameters must be an object.");
      }
      rejectUnknownFields(params, UNDO_ROOT_KEYS, "undo request");
      const requestPath = assertPath(params.path);
      const requestedPath = toCwd(requestPath, ctx.cwd);
      const mutationTargetPath = await resolveMutationTarget(requestPath, ctx.cwd);

      return withFileMutationQueue(mutationTargetPath, async () => {
        abortIf(signal);
        await loadStore();
        const record = getUndoRecord(mutationTargetPath);
        if (!record) {
          throw new Error(
            `[E_NO_UNDO] No undoable hybrid transaction for ${requestPath}. Nothing was modified.`,
          );
        }

        let raw: Buffer;
        try {
          raw = await readFile(mutationTargetPath);
        } catch (error: unknown) {
          if (errCode(error) === "ENOENT") {
            throw new Error(
              `[E_UNDO_STALE] The file ${requestPath} no longer exists. Nothing was modified.`,
            );
          }
          throw error;
        }
        const currentChecksum = sha256Hex(raw);
        if (currentChecksum !== record.afterChecksum) {
          throw new Error(
            `[E_UNDO_STALE] The file has changed since the transaction. Nothing was modified. Undo never overwrites later modifications.`,
          );
        }

        const afterDoc = decodeDocument(record.beforeBytes, requestPath);
        if (afterDoc.lines.length !== record.beforeAnchors.length) {
          throw new Error(
            `[E_STATE_CORRUPT] The stored undo state for ${requestPath} is inconsistent with the file. Nothing was modified.`,
          );
        }
        const afterRaw = record.beforeBytes;
        const afterChecksum = sha256Hex(afterRaw);
        const beforeAnchorsSet = new Set(record.beforeAnchors);
        const restoredRetired = new Set(record.beforeRetired);
        for (const anchor of record.afterAnchors) {
          if (!beforeAnchorsSet.has(anchor)) restoredRetired.add(anchor);
        }

        const currentDoc = decodeDocument(raw, requestPath);
        const currentTexts = currentDoc.lines.map((line) => line.text);
        const diffRows = buildDiffRows(
          currentTexts,
          record.afterAnchors,
          afterDoc.lines.map((line) => line.text),
          record.beforeAnchors,
        );

        const transactionId = newTransactionId();
        abortIf(signal);
        await commitMutation({
          realPath: mutationTargetPath,
          requestedPath,
          label: requestPath,
          rawBefore: raw,
          checksumBefore: currentChecksum,
          docBefore: currentDoc,
          anchorsBefore: record.afterAnchors,
          fingerprintsBefore: record.afterFingerprints,
          retiredBefore: record.afterRetired,
          rawAfter: afterRaw,
          checksumAfter: afterChecksum,
          docAfter: afterDoc,
          anchorsAfter: record.beforeAnchors,
          fingerprintsAfter: record.beforeFingerprints,
          retiredAfter: restoredRetired,
          transactionId,
          signal,
          keepUndo: false,
          warnings: [],
        });
        const { text: diffText, servedRows } = renderAndServeDiffRows(
          diffRows,
          mutationTargetPath,
        );
        let linesAdded = 0;
        let linesRemoved = 0;
        for (const row of diffRows) {
          if (row.prefix === "+") linesAdded++;
          if (row.prefix === "-") linesRemoved++;
        }
        const metrics = buildMutationMetrics({
          classification: "applied",
          editsAttempted: 1,
          editsApplied: 1,
          editsNoop: 0,
          linesAdded,
          linesRemoved,
          warnings: 0,
          beforeRevision: currentChecksum,
          afterRevision: afterChecksum,
          transactionId,
        });
        const text = `Undone the last transaction on ${requestPath}. The file was restored to its exact previous bytes and anchors.\n\n${diffText}`;

        return {
          content: [{ type: "text", text }],
          details: {
            diff: diffText,
            metrics,
            hashline: hashlineDetails({
              outcome: "success",
              code: "OK",
              transactionId,
              fileSha256: afterChecksum,
              servedRows,
            }),
          },
        };
      });
    },
  } as ToolDefinition<any, UndoToolDetails>;
}
