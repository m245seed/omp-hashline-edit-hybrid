/**
 * Error and warning catalogs (spec §54, §55).
 *
 * Error codes are stable identifiers; human-readable wording may change but
 * codes must not. Warnings never alter requested content — a warning means
 * "the exact requested operation occurred, but inspect this condition",
 * never "the engine secretly fixed something".
 */

export const ERROR_CODES = [
  "E_BAD_SHAPE",
  "E_BAD_REF",
  "E_ANCHOR_STALE",
  "E_RANGE_STALE",
  "E_WOULD_EMPTY",
  "E_FILE_REVISION_CHANGED",
  "E_PATH_CHANGED",
  "E_FILE_TOO_LARGE",
  "E_ENCODING_UNSUPPORTED",
  "E_BINARY_FILE",
  "E_ATOMIC_REPLACE_FAILED",
  "E_NO_UNDO",
  "E_UNDO_STALE",
  "E_STATE_CORRUPT",
  "E_ANCHOR_SPACE_LOW",
  "E_ABORTED",
  // Stable rejection codes (spec §31.10).
  "E_ANCHOR_NOT_SERVED",
  "E_RANGE_REVERSED",
  "E_RANGE_OVERLAP",
  "E_EMBEDDED_NEWLINE",
  "E_DISPLAY_LIKE_CONTENT",
  "E_BOUNDARY_DUP",
  "E_LARGE_DESTRUCTIVE_EDIT",
  "E_FILE_CHANGED",
  "E_LINE_TOO_LARGE",
  "E_CONTEXT_EPOCH_STALE",
] as const;

export const WARNING_CODES = [
  "W_BOUNDARY_DUP",
  "W_HARDLINK_NONATOMIC",
  "W_MIXED_LINE_ENDINGS",
  "W_STATE_RECOVERED",
  "W_ANCHOR_SPACE_PRESSURE",
  "W_UNUSED_OPTION",
  "W_SERVED_WINDOW_EXCEEDED",
] as const;

/** Alias for E_DISPLAY_LIKE_CONTENT for backward compatibility. */
export const E_SUSPICIOUS_PATCH = "E_DISPLAY_LIKE_CONTENT";
