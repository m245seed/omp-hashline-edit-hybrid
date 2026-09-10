/**
 * Served-state ledger (spec §8, §9).
 *
 * A line becomes served only when its complete current contents are actually
 * returned to the model in the current Pi session. The ledger records
 * (path, anchor) -> exactText for every fully rendered row from `read`,
 * `grep`, edit diffs, undo diffs, and fresh error feedback.
 *
 * The ledger is session-scoped by design (spec §8.1): anchors and undo
 * survive restarts, but permission to destructively edit previously viewed
 * lines does not — after a restart, `read`/`grep` is required again.
 *
 * Every served entry carries the numeric context epoch it was served in
 * (PH-CONTEXT-001). Entries from older epochs do not authorize destructive
 * edits (PH-CONTEXT-003).
 */

import { getContextEpoch } from "./epoch";

export interface ServedEntry {
  exactText: string;
  epoch: number;
  /**
   * Last-known 0-based line index at serve time (§31.6 stale-anchor
   * recovery metadata). Optional because diff-served rows do not track it.
   */
  lastKnownLineIndex?: number;
  /** ISO timestamp when the row was served (§31.6). */
  servedAt?: string;
}

export type ServedLedger = Map<string, Map<string, ServedEntry>>;

const ledger: ServedLedger = new Map();

/**
 * Session-scoped "shown but now changed" markers (spec §71). When an
 * external change replaces a line that was previously served, the line's
 * fresh anchor is marked stale so the range check can report E_RANGE_STALE
 * ("the content the agent saw changed") instead of E_ANCHOR_NOT_SERVED.
 */
const staleAnchors: Map<string, Set<string>> = new Map();

/** Global insertion/refresh order for the bounded served ledger. */
const globalOrder = new Map<string, { path: string; anchor: string }>();

export function getLedger(): ServedLedger {
  return ledger;
}

export interface ServeEntryInput {
  anchor: string;
  exactText: string;
  lineIndex?: number;
}

// Caps to prevent unbounded session memory growth (plan § Memory Management).
// Each entry holds exactText (up to 200KiB); per-file and global limits keep
// long sessions bounded while preserving edit-ready freshness for recent lines.
const MAX_SERVED_PER_FILE = 5000;
const MAX_SERVED_TOTAL = 20000;

function globalKey(path: string, anchor: string): string {
  return `${path}\u0000${anchor}`;
}

function removeEntry(path: string, anchor: string): void {
  const file = ledger.get(path);
  file?.delete(anchor);
  globalOrder.delete(globalKey(path, anchor));
  if (file && file.size === 0) ledger.delete(path);
}

function evictIfNeeded(): void {
  while (globalOrder.size > MAX_SERVED_TOTAL) {
    const oldest = globalOrder.values().next().value as
      { path: string; anchor: string } | undefined;
    if (oldest === undefined) break;
    removeEntry(oldest.path, oldest.anchor);
  }
}

export function serveLine(
  path: string,
  anchor: string,
  exactText: string,
  lineIndex?: number,
): void {
  const entry: ServedEntry = {
    exactText,
    epoch: getContextEpoch(),
    servedAt: new Date().toISOString(),
  };
  if (lineIndex !== undefined) entry.lastKnownLineIndex = lineIndex;
  putEntry(path, anchor, entry);
}

/** Store a fully-formed served entry (used for epoch-preserving transfers). */
function putEntry(path: string, anchor: string, entry: ServedEntry): void {
  let file = ledger.get(path);
  if (!file) {
    file = new Map();
    ledger.set(path, file);
  }
  // Refresh LRU order: delete then set moves to end
  if (file.has(anchor)) {
    file.delete(anchor);
    globalOrder.delete(globalKey(path, anchor));
  }
  file.set(anchor, entry);
  globalOrder.set(globalKey(path, anchor), { path, anchor });
  // Per-file cap
  while (file.size > MAX_SERVED_PER_FILE) {
    const oldest = file.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    removeEntry(path, oldest);
  }
  evictIfNeeded();
}

export function serveLines(
  path: string,
  entries: Array<ServeEntryInput>,
): number {
  if (entries.length === 0) return 0;
  const epoch = getContextEpoch();
  const servedAt = new Date().toISOString();
  for (const entry of entries) {
    const stored: ServedEntry = { exactText: entry.exactText, epoch, servedAt };
    if (entry.lineIndex !== undefined)
      stored.lastKnownLineIndex = entry.lineIndex;
    putEntry(path, entry.anchor, stored);
  }
  // Rows shown in THIS call must remain editable: count how many were
  // evicted by the per-file or global caps so callers can warn the model —
  // an evicted row fails edits with E_ANCHOR_NOT_SERVED despite having
  // just been displayed.
  let evictedNow = 0;
  const file = ledger.get(path);
  for (const entry of entries) {
    if (!file?.has(entry.anchor)) evictedNow++;
  }
  return evictedNow;
}

/**
 * Notice appended to any output whose freshly served rows exceeded the
 * served window: those rows were displayed but evicted from the ledger,
 * so they are not edit-authorized until re-read.
 */
export function servedWindowNotice(evicted: number): string {
  return `\n\n[W_SERVED_WINDOW_EXCEEDED] ${evicted} of the rows shown above exceeded the served window (${MAX_SERVED_PER_FILE} lines per file, ${MAX_SERVED_TOTAL} total) and were evicted; they are not authorized for edits. Re-read the range with read before editing those lines.`;
}

/** Exact text previously served for (path, anchor), or undefined. */
export function servedText(path: string, anchor: string): string | undefined {
  return ledger.get(path)?.get(anchor)?.exactText;
}

/** Full served entry (text + epoch) for (path, anchor), or undefined. */
export function servedEntry(
  path: string,
  anchor: string,
): ServedEntry | undefined {
  return ledger.get(path)?.get(anchor);
}

export function markStale(path: string, anchor: string): void {
  let set = staleAnchors.get(path);
  if (!set) {
    set = new Set();
    staleAnchors.set(path, set);
  }
  // No cap, unlike the served ledger: stale markers are 4-character anchor
  // strings (served entries hold exactText of up to 200 KiB). Capping them
  // would silently downgrade E_RANGE_STALE feedback to E_ANCHOR_NOT_SERVED.
  set.add(anchor);
}

export function isStale(path: string, anchor: string): boolean {
  return staleAnchors.get(path)?.has(anchor) ?? false;
}

export function getStaleSet(path: string): ReadonlySet<string> | undefined {
  return staleAnchors.get(path);
}

export function clearServedPath(path: string): void {
  const file = ledger.get(path);
  if (file) {
    for (const anchor of file.keys()) {
      globalOrder.delete(globalKey(path, anchor));
    }
  }
  ledger.delete(path);
  staleAnchors.delete(path);
}

/**
 * Invalidate served authorization after a whole-file write (spec §37):
 * keep entries whose line still exists with identical content, drop the rest.
 */
export function pruneServedPath(
  path: string,
  current: Map<string, string>,
): void {
  const file = ledger.get(path);
  if (!file) return;
  for (const [anchor, entry] of [...file]) {
    if (current.get(anchor) !== entry.exactText) {
      removeEntry(path, anchor);
    }
  }
  if (file.size === 0) ledger.delete(path);
}
/** Test helper. */
export function resetServed(): void {
  ledger.clear();
  globalOrder.clear();
  staleAnchors.clear();
}

/**
 * Reconcile served authorization against an externally changed document
 * (spec §7, §71).
 *
 * - Lines preserved by the alignment keep (or transfer) their authorization.
 * - A line that was served before and now changed keeps a stale marker on
 *   its fresh anchor, so authorization failures report E_RANGE_STALE
 *   ("shown but now changed") rather than E_ANCHOR_NOT_SERVED.
 * - Served entries for removed lines stay dormant; their anchors are
 *   retired and can only become live again through undo (which restores
 *   the exact bytes, so the entry remains valid).
 */
export function reconcileServed(
  path: string,
  oldAnchors: readonly string[],
  mapping: ReadonlyMap<number, number>,
  newAnchors: readonly string[],
  newTexts: readonly string[],
): void {
  // Transfers can themselves evict entries when the new document grows past
  // the global cap. Snapshot the old authorization first so stale-gap
  // detection cannot depend on transfer order.
  const servedOld = new Map<string, ServedEntry>();
  for (const anchor of oldAnchors) {
    const entry = servedEntry(path, anchor);
    if (entry !== undefined) servedOld.set(anchor, entry);
  }
  for (const [newIdx, oldIdx] of mapping) {
    const oldEntry = servedOld.get(oldAnchors[oldIdx]!);
    if (oldEntry !== undefined && oldEntry.exactText === newTexts[newIdx]!) {
      // Transfer the authorization as-is, preserving the epoch it was
      // actually served in (PH-CONTEXT-003): an external change must never
      // refresh an older epoch's authorization.
      putEntry(path, newAnchors[newIdx]!, {
        ...oldEntry,
        lastKnownLineIndex: newIdx,
      });
    }
  }
  if (oldAnchors.length === 0) return;
  // Build O(1) gap check via prefix sum over served old indexes
  const isServedOld = new Uint8Array(oldAnchors.length);
  let hasServed = false;
  for (let i = 0; i < oldAnchors.length; i++) {
    if (servedOld.has(oldAnchors[i]!)) {
      isServedOld[i] = 1;
      hasServed = true;
    }
  }
  if (!hasServed) return;
  // Prefix sum for O(1) gap query
  const prefix = new Uint32Array(oldAnchors.length + 1);
  for (let i = 0; i < oldAnchors.length; i++) {
    prefix[i + 1] = prefix[i]! + isServedOld[i]!;
  }
  if (mapping.size === 0) {
    // No anchors preserved: whole old gap contains served line -> all new lines stale
    const gapHasServed = prefix[oldAnchors.length]! - prefix[0]! > 0;
    if (gapHasServed) {
      for (let j = 0; j < newAnchors.length; j++)
        markStale(path, newAnchors[j]!);
    }
    return;
  }
  // The only mapping producer (alignSequences, Myers LCS) is monotone:
  // entries sorted by newIdx also have non-decreasing oldIdx. Guard against
  // a hypothetical non-monotone (crossing) map degrading silently: clamp
  // the gap to [min(prevOld, nextOld), max(prevOld, nextOld)] so a crossing
  // pair can only over-mark stale (conservative), never skip a served line.
  const sortedEntries = [...mapping.entries()].sort((a, b) => a[0] - b[0]);
  let p = -1;
  for (let j = 0; j < newAnchors.length; j++) {
    if (mapping.has(j)) continue;
    while (p + 1 < sortedEntries.length && sortedEntries[p + 1]![0] < j) p++;
    const prevOld = p >= 0 ? sortedEntries[p]![1] : -1;
    const nextOld =
      p + 1 < sortedEntries.length
        ? sortedEntries[p + 1]![1]
        : oldAnchors.length;
    const gapHasServed =
      prefix[Math.max(prevOld, nextOld)]! -
        prefix[Math.min(prevOld, nextOld) + 1]! >
      0;
    if (gapHasServed) markStale(path, newAnchors[j]!);
  }
}
