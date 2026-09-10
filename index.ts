/**
 * omp-hashline-edit-hybrid — fail-closed, hash-anchored text mutation for
 * Oh My Pi coding agents (spec §1, §31).
 *
 * Tools: read, grep, edit, insert, write, undo. The generic pi `edit` and
 * `write` tools are replaced by the hybrid tools (custom tools override
 * built-ins by name); the hashline `write` override is the sole safe_write
 * owner (PH-WRITE-003). A successful external `write` triggers anchor
 * reconciliation and an optional auto-read preview.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildReadToolDef } from "./src/tools/read";
import { buildGrepToolDef } from "./src/tools/grep";
import { buildEditToolDef } from "./src/tools/edit";
import { buildInsertToolDef } from "./src/tools/insert";
import { buildWriteToolDef } from "./src/tools/write";
import { buildUndoToolDef } from "./src/tools/undo";
import { registerWriteHook } from "./src/integration/write-hook";
import { registerSession } from "./src/integration/session";
export default function (pi: ExtensionAPI): void {
  const autoReadState = { value: true };
  const readTool = buildReadToolDef();
  const grepTool = buildGrepToolDef();
  const editTool = buildEditToolDef();
  const insertTool = buildInsertToolDef();
  const writeTool = buildWriteToolDef();
  const undoTool = buildUndoToolDef();
  pi.registerTool(readTool);
  pi.registerTool(grepTool);
  pi.registerTool(editTool);
  pi.registerTool(insertTool);
  pi.registerTool(writeTool);
  pi.registerTool(undoTool);
  registerWriteHook(pi, () => autoReadState.value);
  registerSession(pi, autoReadState);
}
