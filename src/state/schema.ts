/** SQLite state schema (spec §50). */

export const FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  raw_checksum TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  anchor_epoch INTEGER NOT NULL,
  anchors BLOB NOT NULL,
  fingerprints BLOB NOT NULL,
  retired BLOB NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const UNDO_TABLE = `
CREATE TABLE IF NOT EXISTS undo (
  path TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  before_bytes BLOB NOT NULL,
  after_checksum TEXT NOT NULL,
  before_anchors BLOB NOT NULL,
  before_fingerprints BLOB NOT NULL,
  before_retired BLOB NOT NULL,
  after_anchors BLOB NOT NULL,
  after_fingerprints BLOB NOT NULL,
  after_retired BLOB NOT NULL,
  created_at INTEGER NOT NULL
)`;

export const PENDING_TABLE = `
CREATE TABLE IF NOT EXISTS pending_transactions (
  transaction_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  before_checksum TEXT NOT NULL,
  after_checksum TEXT NOT NULL,
  before_anchors BLOB NOT NULL,
  before_fingerprints BLOB NOT NULL,
  before_retired BLOB NOT NULL,
  before_line_count INTEGER NOT NULL,
  after_anchors BLOB NOT NULL,
  after_fingerprints BLOB NOT NULL,
  after_retired BLOB NOT NULL,
  after_line_count INTEGER NOT NULL,
  undo_before_bytes BLOB,
  undo_after_checksum TEXT,
  undo_before_anchors BLOB,
  undo_before_fingerprints BLOB,
  undo_before_retired BLOB,
  created_at INTEGER NOT NULL
)`;

export const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

export const SCHEMA_KEY = "schema_version";
