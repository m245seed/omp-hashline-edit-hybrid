/**
 * `edit` tool (spec §13–§22, PH-PROTO-001..003, PH-EDIT-001..008,
 * PH-CONCURRENCY-001..003).
 *
 * Performs one or more range replacements atomically within one file. All
 * ranges resolve against the same original document; every line of every
 * destructive range must have been served and still match; overlapping
 * ranges are rejected; the transaction commits once and returns one
 * combined anchored diff.
 *
 * Before commit, two safety preflights run (PH-EDIT-001, PH-EDIT-006):
 * boundary-duplicate detection rejects `E_BOUNDARY_DUP` by default, and the
 * large-destructive guard rejects `E_LARGE_DESTRUCTIVE_EDIT`. Both have
 * explicit top-level escape hatches and never authorize an edit on their own.
 */

import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf } from "../utils";
import { withFileMutationQueue } from "../filesystem/resolve-target";
import { resolveMutationTarget, commitAndRenderMutation } from "./shared";
import {
  EXPECTED_REVISION_DESCRIPTION,
  EXPECTED_REVISION_PATTERN,
  getLargeEditGuard,
  HASHLINE_PROTOCOL_ID,
} from "../constants";
import {
  validateEditRequest,
  type EditRequest,
} from "../mutation/validate";
import { staleAnchorMessage, unknownAnchorMessage, reversedRangeMessage } from "../mutation/resolve";
import {
  applyTransaction,
  type EditOp,
} from "../mutation/apply";
import { loadAnchoredFile } from "../mutation/transaction";
import { checkRangeServed, formatRangeFailure } from "../served/authorize";
import {
  detectBoundaryDuplication,
  type BoundaryDupFinding,
  boundaryDupRejection,
  boundaryDupWarning,
  computePostTransactionTexts,
  isLargeDestructiveChange,
  largeDestructiveRejection,
} from "../render/warnings";
import { hashlineDetails } from "../render/result-details";
import type { MutationMetrics } from "./shared";
export type { MutationMetrics } from "./shared";

export interface EditToolDetails {
  diff?: string;
  metrics: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

// Authoritative checks in src/mutation/validate.ts
const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(
      Type.Object(
        {
          range: Type.Array(Type.String({ pattern: "^[A-Za-z0-9]{4}$" }), {
            minItems: 2,
            maxItems: 2,
            description:
              "Exactly two anchors [start, end], both inclusive. Use the same anchor twice for a single-line replacement.",
          }),
          lines: Type.Array(Type.String(), {
            description:
              "Literal logical output lines replacing the range. Use [] to delete.",
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    allow_display_like_content: Type.Optional(
      Type.Boolean({
        description:
          "When true, write replacement lines that look like hashline tool output literally instead of rejecting them.",
      }),
    ),
    allow_boundary_duplicate: Type.Optional(
      Type.Boolean({
        description:
          "When true, permit a replacement that duplicates the unchanged block immediately before/after the range (E_BOUNDARY_DUP is suppressed).",
      }),
    ),
    allow_large_change: Type.Optional(
      Type.Boolean({
        description:
          "When true, permit an unusually destructive replacement (E_LARGE_DESTRUCTIVE_EDIT is suppressed).",
      }),
    ),
    final_newline: Type.Optional(
      Type.Union([
        Type.Literal("preserve"),
        Type.Literal("present"),
        Type.Literal("absent"),
      ]),
    ),
    expected_revision: Type.Optional(
      Type.String({
        pattern: EXPECTED_REVISION_PATTERN,
        description: EXPECTED_REVISION_DESCRIPTION,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

const E_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Replace one or more anchored line ranges in a single file, atomically. Ranges reference the 4-character anchors returned by read/grep/diff output. Every line in every range must have been shown to you in this session with exactly the content it has now; otherwise the whole call fails and nothing is modified. Multiple ranges are validated together and committed as one transaction.`;

const E_SNIPPET =
  "edit: replace anchored ranges in one file; all ranges must be fully shown and exact; ranges must not overlap; nothing is applied unless every edit validates.";

const E_GUIDELINES = [
  "Only use anchors that were returned to you (read, grep, or the diff of a previous mutation). Never invent or guess anchors.",
  "Replacement lines are literal: never include rendered `ANCHOR│` prefixes or diff `+`/`-` markers. Such content is rejected, not stripped.",
  "Ranges are inclusive and resolved against the same pre-edit file; overlapping ranges (even sharing one endpoint line) are rejected.",
  "Review the anchored diff after every successful edit before making dependent edits.",
];

export function buildEditToolDef(): ToolDefinition<any, EditToolDetails> {
  return {
    name: "edit",
    label: "Edit",
    description: E_DESC,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDELINES,
    parameters: editSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateEditRequest(params);
      const requestedPath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveMutationTarget(request.path, ctx.cwd);
      return runEdit({ request, requestedPath, mutationTargetPath, signal });
    },
  } as ToolDefinition<any, EditToolDetails>;
}

interface RunEditInput {
  request: EditRequest;
  requestedPath: string;
  mutationTargetPath: string;
  signal?: AbortSignal;
}

async function runEdit(input: RunEditInput): Promise<ReturnType<ToolDefinition<any, EditToolDetails>["execute"]>> {
  const { request, requestedPath, mutationTargetPath, signal } = input;
  return withFileMutationQueue(mutationTargetPath, async () => {
    abortIf(signal);
    const file = await loadAnchoredFile(mutationTargetPath, request.path);
    const anchorIndex = new Map<string, number>(file.anchors.map((a, i) => [a, i]));

    const ops: EditOp[] = [];
    for (let i = 0; i < request.edits.length; i++) {
      const item = request.edits[i]!;
      const startAnchor = item.range[0];
      const endAnchor = item.range[1];
      const start = anchorIndex.get(startAnchor);
      const end = anchorIndex.get(endAnchor);
      if (start === undefined) {
        throw new Error(
          file.retired.has(startAnchor)
            ? staleAnchorMessage(
                mutationTargetPath,
                startAnchor,
                file.anchors,
                file.texts,
                end,
              )
            : unknownAnchorMessage(request.path, startAnchor, file.anchors),
        );
      }
      if (end === undefined) {
        throw new Error(
          file.retired.has(endAnchor)
            ? staleAnchorMessage(
                mutationTargetPath,
                endAnchor,
                file.anchors,
                file.texts,
                start,
              )
            : unknownAnchorMessage(request.path, endAnchor, file.anchors),
        );
      }
      if (start > end) {
        throw new Error(
          reversedRangeMessage(request.path, startAnchor, endAnchor),
        );
      }
      ops.push({ kind: "edit", start, end, lines: item.lines, requestIndex: i });
    }

    // Served-range authorization (spec §10, PH-CONTEXT-003).
    for (const op of ops) {
      const check = checkRangeServed(
        mutationTargetPath,
        file.anchors,
        file.texts,
        op.start,
        op.end,
      );
      if (!check.ok) {
        throw new Error(
          formatRangeFailure(
            request.path,
            mutationTargetPath,
            file.anchors,
            file.texts,
            op.start,
            op.end,
            check,
          ),
        );
      }
    }

    abortIf(signal);
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
      { finalNewline: request.final_newline },
    );

    return commitAndRenderMutation({
      tool: "edit",
      displayPath: request.path,
      requestedPath,
      realPath: mutationTargetPath,
      file,
      result,
      expectedRevision: request.expected_revision,
      signal,
      preflight: (addWarning) => {
        // ── Safety preflights (run before commit; PH-EDIT-001/006) ─────────
        const sortedOps = [...ops].sort((a, b) => a.start - b.start);

        // Large destructive guard (PH-EDIT-006..008), per edit for a precise
        // operation index (§31.10).
        if (request.allow_large_change !== true) {
          for (const op of sortedOps) {
            const removed = op.end - op.start + 1;
            const added = op.lines.length;
            const guard = getLargeEditGuard();
            if (isLargeDestructiveChange(removed, added, guard)) {
              throw new Error(
                largeDestructiveRejection(request.path, removed, added, guard),
              );
            }
          }
        }

        // Boundary-duplicate detection (PH-EDIT-001..005) against the lines
        // that will be adjacent AFTER the whole transaction applies.
        const { texts: postTexts, insertPositions } = computePostTransactionTexts(
          file.texts,
          sortedOps,
        );
        const boundaryFindings: Array<{ requestIndex: number; range: [string, string]; findings: BoundaryDupFinding[] }> = [];
        for (let i = 0; i < sortedOps.length; i++) {
          const op = sortedOps[i]!;
          const pos = insertPositions[i]!;
          const before = postTexts.slice(0, pos);
          const after = postTexts.slice(pos + op.lines.length);
          const findings = detectBoundaryDuplication(op.lines, before, after);
          if (findings.length > 0) {
            const range: [string, string] = [file.anchors[op.start]!, file.anchors[op.end]!];
            boundaryFindings.push({ requestIndex: op.requestIndex, range, findings });
          }
        }
        if (boundaryFindings.length > 0) {
          if (request.allow_boundary_duplicate !== true) {
            const first = boundaryFindings[0]!;
            throw new Error(
              boundaryDupRejection(
                request.path,
                first.requestIndex,
                first.range,
                first.findings,
              ),
            );
          }
          // Escape hatch used: apply literally but flag it for review (§55).
          for (const { requestIndex, range, findings } of boundaryFindings) {
            addWarning(
              boundaryDupWarning(request.path, requestIndex, range, findings),
            );
          }
        }
      },
    });
  });
}
