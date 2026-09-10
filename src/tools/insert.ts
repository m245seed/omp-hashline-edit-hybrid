/**
 * `insert` tool (spec §23, PH-PROTO-001..003, PH-CONCURRENCY-001..003).
 *
 * Insertion stays separate from replacement. Each insert adds lines before
 * or after a single anchor line; the anchor line itself must have been
 * served and must still match. Multiple insertions in one call are
 * transactional; same anchor + direction keep request order.
 */

import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import { toCwd } from "../paths";
import { abortIf } from "../utils";
import { withFileMutationQueue } from "../filesystem/resolve-target";
import { resolveMutationTarget, commitAndRenderMutation } from "./shared";
import { validateInsertRequest } from "../mutation/validate";
import { staleAnchorMessage, unknownAnchorMessage } from "../mutation/resolve";
import {
  applyTransaction,
  type InsertOp,
} from "../mutation/apply";
import { loadAnchoredFile } from "../mutation/transaction";
import { hashlineDetails } from "../render/result-details";
import {
  EXPECTED_REVISION_DESCRIPTION,
  EXPECTED_REVISION_PATTERN,
  HASHLINE_PROTOCOL_ID,
} from "../constants";
import { checkRangeServed, formatRangeFailure } from "../served/authorize";
import type { MutationMetrics } from "./shared";
export interface InsertToolDetails {
  /** Rendered anchored diff text (same content as the text response);
   * omitted for no-op transactions, which produce no diff. */
  diff?: string;
  metrics: MutationMetrics;
  hashline: ReturnType<typeof hashlineDetails>;
}

// Authoritative checks in src/mutation/validate.ts
const insertSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to modify" }),
    inserts: Type.Array(
      Type.Object(
        {
          anchor: Type.String({
            pattern: "^[A-Za-z0-9]{4}$",
            description:
              "Bare 4-character anchor of the line to insert around; the anchor line itself is preserved.",
          }),
          direction: Type.Union([
            Type.Literal("before"),
            Type.Literal("after"),
          ]),
          lines: Type.Array(Type.String(), {
            description: "Literal logical lines to insert.",
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    allow_display_like_content: Type.Optional(Type.Boolean()),
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

const I_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Insert literal lines before or after a single anchor line in one file. The anchor line itself is preserved and must have been shown to you in this session with exactly its current content. Multiple inserts in one call are validated together and committed as one transaction.`;

const I_SNIPPET =
  "insert: add lines before/after an anchored line; the anchor line must have been shown and must still match; multiple inserts commit atomically.";

const I_GUIDELINES = [
  "Only use anchors that were returned to you; never invent anchors.",
  "Inserted lines are literal: never include rendered `ANCHOR│` prefixes or diff markers.",
  "Do not repeat the anchor line's own content in `lines`.",
];

export function buildInsertToolDef(): ToolDefinition<any, InsertToolDetails> {
  return {
    name: "insert",
    label: "Insert",
    description: I_DESC,
    promptSnippet: I_SNIPPET,
    promptGuidelines: I_GUIDELINES,
    parameters: insertSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = validateInsertRequest(params);
      const requestedPath = toCwd(request.path, ctx.cwd);
      const mutationTargetPath = await resolveMutationTarget(request.path, ctx.cwd);
      return runInsert({ request, requestedPath, mutationTargetPath, signal });
    },
  } as ToolDefinition<any, InsertToolDetails>;
}

interface RunInsertInput {
  request: ReturnType<typeof validateInsertRequest>;
  requestedPath: string;
  mutationTargetPath: string;
  signal?: AbortSignal;
}

async function runInsert(input: RunInsertInput): Promise<ReturnType<ToolDefinition<any, InsertToolDetails>["execute"]>> {
  const { request, requestedPath, mutationTargetPath, signal } = input;
  return withFileMutationQueue(mutationTargetPath, async () => {
    abortIf(signal);
    const file = await loadAnchoredFile(mutationTargetPath, request.path);
    const anchorIndex = new Map<string, number>(file.anchors.map((a, i) => [a, i]));

    const ops: InsertOp[] = [];
    for (let i = 0; i < request.inserts.length; i++) {
      const item = request.inserts[i]!;
      const idx = anchorIndex.get(item.anchor);
      if (idx === undefined) {
        throw new Error(
          file.retired.has(item.anchor)
            ? staleAnchorMessage(
                mutationTargetPath,
                item.anchor,
                file.anchors,
                file.texts,
              )
            : unknownAnchorMessage(request.path, item.anchor, file.anchors),
        );
      }
      const check = checkRangeServed(mutationTargetPath, file.anchors, file.texts, idx, idx);
      if (!check.ok) {
        throw new Error(
          formatRangeFailure(request.path, mutationTargetPath, file.anchors, file.texts, idx, idx, check),
        );
      }
      ops.push({
        kind: "insert",
        anchorIndex: idx,
        direction: item.direction,
        lines: item.lines,
        requestIndex: i,
      });
    }

    abortIf(signal);
    const result = applyTransaction(
      file.doc,
      { anchors: file.anchors, retired: file.retired },
      ops,
      { finalNewline: request.final_newline },
    );

    return commitAndRenderMutation({
      tool: "insert",
      displayPath: request.path,
      requestedPath,
      realPath: mutationTargetPath,
      file,
      result,
      expectedRevision: request.expected_revision,
      signal,
    });
  });
}
