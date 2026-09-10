/**
 * `read` tool (spec §12, §25, §27, PH-PROTO-001..003, PH-OUTPUT-001..006).
 *
 * Returns complete lines with `anchor│text` rows. Read guarantees: resolve
 * symlink targets consistently, validate file type, reject unsupported
 * encodings, reconcile the persistent anchor state, return complete lines
 * up to the display limit, and record only fully rendered lines as served.
 * The current revision (SHA-256 of raw bytes) is exposed in details for
 * `expected_revision` CAS mode.
 */

import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import { abortIf, isRec, normPosInt, rejectUnknownFields } from "../utils";
import {
  DEFAULT_READ_LIMIT,
  READ_MAX_OUTPUT_BYTES,
  HASHLINE_PROTOCOL_ID,
} from "../constants";
import { resolveMutationTarget } from "./shared";
import { withFileMutationQueue } from "../filesystem/resolve-target";
import { loadAnchoredFile } from "../mutation/transaction";
import { renderLinesBounded } from "../render/engine";
import { serveLines, servedWindowNotice } from "../served/ledger";
import { hashlineDetails } from "../render/result-details";
import { assertPath } from "../mutation/validate";

const READ_ROOT_KEYS = new Set(["path", "offset", "limit"]);
export interface ReadToolDetails {
  revision: string;
  totalLines: number;
  shownLines: number;
  nextOffset?: number;
  hashline: ReturnType<typeof hashlineDetails>;
}

const readSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to read" }),
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-indexed line to start from" }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of lines to return",
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);
const R_DESC = `Protocol-ID: ${HASHLINE_PROTOCOL_ID} (anchor width 4). Read a text file with stable 4-character hash anchors. Every returned row is \`anchor│content\`; the anchors are edit-ready — use them with edit, insert, and grep without re-reading. Output is paged: without \`limit\`, at most ${DEFAULT_READ_LIMIT} lines are returned (use \`offset\` to continue). Lines too large to display are omitted with a note and are not editable until inspected.`;

const R_SNIPPET =
  "read: return file lines with stable `ANCHOR│content` rows; anchors are edit-ready and become authorized for destructive edits.";

const R_GUIDELINES = [
  "Only lines actually shown in a tool result become editable; after a session restart, re-read before editing.",
  "Use offset/limit for paging; the returned anchors stay valid across pagination.",
];

export function buildReadToolDef(): ToolDefinition<any, ReadToolDetails> {
  return {
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: R_GUIDELINES,
    parameters: readSchema,
    executionMode: "parallel",

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Record<string, unknown>;
      if (!isRec(params)) {
        throw new Error("[E_BAD_SHAPE] read parameters must be an object.");
      }
      rejectUnknownFields(params, READ_ROOT_KEYS, "read request");
      const requestPath = assertPath(params.path);
      const offset = normPosInt(params.offset, "offset");
      const limit = normPosInt(params.limit, "limit");
      const realPath = await resolveMutationTarget(requestPath, ctx.cwd);
      return withFileMutationQueue(realPath, async () => {
        abortIf(signal);

        const file = await loadAnchoredFile(realPath, requestPath);
        const total = file.texts.length;

        if ((offset ?? 1) > total) {
          return {
            content: [
              {
                type: "text",
                text: `Offset ${offset} is beyond end of file (${total} lines total). Use offset=1 to read from the start.`,
              },
            ],
            details: {
              revision: file.checksum,
              totalLines: total,
              shownLines: 0,
              hashline: hashlineDetails({
                outcome: "no_match",
                code: "OFFSET_BEYOND_EOF",
                fileSha256: file.checksum,
                servedRows: 0,
              }),
            },
          };
        }

        const start = (offset ?? 1) - 1;
        const end = Math.min(start + (limit ?? DEFAULT_READ_LIMIT), total);
        const bounded = renderLinesBounded(
          file.anchors,
          file.texts,
          start,
          end,
        );
        const evictedRows = serveLines(realPath, bounded.served);

        let output = bounded.text;
        let nextOffset: number | undefined;
        if (total === 1 && file.texts[0] === "" && file.raw.length === 0) {
          output = `${output}\n[File is empty. Use edit or insert to add content.]`;
        } else if (bounded.truncated) {
          // Byte budget dropped rows: continuation resumes at the first
          // dropped line (PH-OUTPUT-006).
          nextOffset = bounded.nextLine + 1;
          output += `\n\n[Output truncated at the ${READ_MAX_OUTPUT_BYTES / 1024}KB budget; showing lines ${start + 1}-${bounded.nextLine} of ${total}. Use offset=${nextOffset} to continue.]`;
        } else if (end < total) {
          nextOffset = end + 1;
          output += `\n\n[Showing lines ${start + 1}-${end} of ${total}. Use offset=${nextOffset} to continue.]`;
        } else if (total > 1) {
          output += `\n\n[Showing lines ${start + 1}-${end} of ${total}.]`;
        }
        if (evictedRows > 0) {
          output += servedWindowNotice(evictedRows);
        }

        return {
          content: [{ type: "text", text: output }],
          details: {
            revision: file.checksum,
            totalLines: total,
            shownLines: bounded.served.length,
            ...(nextOffset !== undefined ? { nextOffset } : {}),
            hashline: hashlineDetails({
              outcome: "success",
              code: "OK",
              fileSha256: file.checksum,
              servedRows: bounded.served.length,
            }),
          },
        };
      });
    },
  } as ToolDefinition<any, ReadToolDetails>;
}
