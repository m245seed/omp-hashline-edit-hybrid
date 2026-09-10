/**
 * Session lifecycle (spec §8.1, §31, §49, PH-CONTEXT-001..005).
 *
 * At session start: open the state store, run crash recovery on pending
 * transactions, reset the served ledger. Anchors and undo
 * survive restarts, but permission to destructively edit previously viewed
 * lines is session-scoped and does not survive.
 *
 * Context epochs (PH-CONTEXT-003): the served-authorization epoch advances
 * when the model's context is rebuilt — compaction — so anchors from the
 * previous context no longer authorize destructive edits. Undo history and
 * file identity are independent of the epoch (PH-CONTEXT-005).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadStore, shutdownStore } from "../state/database";
import { runRecovery } from "../state/recovery";
import { resetServed } from "../served/ledger";
import { advanceContextEpoch } from "../served/epoch";

export function registerSession(pi: ExtensionAPI, autoReadState: { value: boolean }): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await loadStore();
      const summary = await runRecovery();
      for (const warning of summary.warnings) {
        console.warn(warning);
      }
      if (summary.promoted > 0 || summary.discarded > 0 || summary.diverged > 0) {
        ctx.ui.notify(
          `Hashline state recovery: ${summary.promoted} transaction(s) finalized, ${summary.discarded} discarded, ${summary.diverged} diverged.`,
          "info",
        );
      }
    } catch (error) {
      console.error("Failed to open hashline state store:", error);
    }
    resetServed();
  });

  pi.on("session_compact", () => {
    advanceContextEpoch();
  });

  pi.on("session_shutdown", () => {
    shutdownStore();
  });

  pi.registerCommand("toggle-auto-read", {
    description:
      "Toggle automatic anchored preview after write (default: enabled)",
    handler: async (_args, ctx) => {
      autoReadState.value = !autoReadState.value;
      ctx.ui.notify(
        `Auto-read anchors after write: ${autoReadState.value ? "enabled" : "disabled"}`,
        "info",
      );
    },
  });
}
