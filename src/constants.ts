/** Resource-control limits and canonical protocol IDs (spec §31, §53). */
export const HASHLINE_PROTOCOL_ID = "pi-hashline/1" as const;
export const HASHLINE_RESULT_PROTOCOL = "pi-hashline-result/1" as const;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_LINES = 250_000;
export const MAX_DISPLAY_LINE_BYTES = 200 * 1024;
export const MAX_FEEDBACK_LINES = 100;
/** Default page size for read. */
export const DEFAULT_READ_LIMIT = 2000;
/**
 * Post-write auto-read preview limits (PH-WRITE-002): independent default of
 * 100 lines plus a total byte cap.
 */
export const AUTO_READ_MAX_LINES = 100;
export const AUTO_READ_MAX_BYTES = 64 * 1024;
/** Total output budgets (PH-OUTPUT-003). */
export const READ_MAX_OUTPUT_BYTES = 512 * 1024;
export const DIFF_MAX_OUTPUT_BYTES = 256 * 1024;
export const SNIFF_BYTES = 8192;
export const STALE_TEMP_MS = 60 * 60 * 1000;
export const ANCHOR_SPACE_PRESSURE_RATIO = 0.95;

/**
 * Large destructive edit guard thresholds (PH-EDIT-006..008).
 * Use getLargeEditGuard() / setLargeEditGuard() to inspect or adjust.
 */
export interface LargeEditGuardConfig {
  readonly minRemovedLines: number;
  readonly removedRatio: number;
}

let activeLargeEditGuard: LargeEditGuardConfig = Object.freeze({
  minRemovedLines: 20,
  removedRatio: 3,
});

export function getLargeEditGuard(): LargeEditGuardConfig {
  return activeLargeEditGuard;
}

export function setLargeEditGuard(config: Partial<LargeEditGuardConfig>): void {
  const next = {
    ...activeLargeEditGuard,
    ...config,
  };
  if (!Number.isInteger(next.minRemovedLines) || next.minRemovedLines < 1) {
    throw new Error(
      '[E_BAD_SHAPE] "minRemovedLines" must be a positive integer.',
    );
  }
  if (!Number.isFinite(next.removedRatio) || next.removedRatio < 0) {
    throw new Error(
      '[E_BAD_SHAPE] "removedRatio" must be a finite non-negative number.',
    );
  }
  activeLargeEditGuard = Object.freeze(next);
}

/** Persistent store tuning (spec §49). */
export const DB_BUSY_TIMEOUT = 1000;
export const DB_BUSY_RETRIES = 3;
export const DB_BUSY_RETRY_DELAY_MS = 100;
export const SCHEMA_VERSION = 1;
