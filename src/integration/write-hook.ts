/**
 * Integration with external `write` results (spec §37, §38, §42, PH-WRITE-002).
 *
 * When a write succeeds OUTSIDE hashline (e.g. another extension or a
 * fallback built-in write), it is an authoritative whole-file mutation:
 * clear hybrid undo for that file, reconcile/regenerate the anchor mapping,
 * retire removed anchors, invalidate served authorization for lines that no
 * longer match, and (with auto-read enabled, the default) return an anchored
 * preview — which also records served state. A failed write must not clear
 * undo, so the hook only runs on successful results.
 *
 * Results produced by hashline's own `write` tool carry a
 * `details.hashline` marker and are skipped: that tool already reconciles
 * anchors, records undo, and returns a bounded preview. The auto-read
 * preview is bounded by an independent 100-line default plus a total byte
 * cap (PH-WRITE-002).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { toCwd } from "../paths";
import { resolveTarget, withFileMutationQueue } from "../filesystem/resolve-target";
import { loadAnchoredFile } from "../mutation/transaction";
import { clearUndoRecord } from "../state/undo";
import { pruneServedPath } from "../served/ledger";
import { HASHLINE_RESULT_PROTOCOL } from "../constants";
import { renderAutoReadPreview } from "../tools/shared";

function isOwnHashlineWrite(event: { details?: unknown }): boolean {
  const details = event.details as { hashline?: { protocol?: unknown } } | undefined;
  return details?.hashline?.protocol === HASHLINE_RESULT_PROTOCOL;
}


export function registerWriteHook(
  pi: ExtensionAPI,
  getAutoRead: () => boolean,
): void {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write") return;
    // Hashline's own write tool already reconciled and previewed.
    if (isOwnHashlineWrite(event)) return;
    const writtenPath = (event.input as Record<string, unknown>)?.path;
    if (typeof writtenPath !== "string") return;

    try {
      const realPath = await resolveTarget(toCwd(writtenPath, ctx.cwd));
      // Serialize with per-file mutation queue to avoid racing anchor
      // reconciliation against concurrent edit/insert transactions.
      return await withFileMutationQueue(realPath, async () => {
        // Authoritative whole-file mutation: clear undo and re-anchor.
        await clearUndoRecord(realPath);
        const file = await loadAnchoredFile(realPath, writtenPath);
        const current = new Map<string, string>();
        for (let i = 0; i < file.anchors.length; i++) {
          current.set(file.anchors[i]!, file.texts[i]!);
        }
        pruneServedPath(realPath, current);

        if (!getAutoRead()) return;
        const { text: previewText } = renderAutoReadPreview(
          file.anchors,
          file.texts,
          realPath,
        );
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${previewText}` },
          ],
        };
      });
    } catch (error) {
      console.error("Auto-read after write failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
        ],
      };
    }
  });
}
