/**
 * Persistent store (spec §48, §49).
 *
 * SQLite under the Pi/XDG configuration area, WAL mode with synchronous=NORMAL,
 * busy timeout with bounded busy retries, schema versioning, a quick
 * integrity check, and corruption quarantine: a corrupted store is renamed
 * to a timestamped quarantine file, a clean store is created, and anchors
 * are reconstructed safely from disk.
 *
 * Durability tradeoff (synchronous=NORMAL): committed rows survive
 * application crashes, but a power loss or OS crash can lose the most
 * recent WAL commits — including a pending_transactions row whose file
 * replacement already reached disk. Recovery then sees no journal entry,
 * so undo for that transaction is unavailable; the file itself is never
 * corrupted. This trades a small crash window for materially lower fsync
 * latency.
 */

import { mkdir, rename } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { statePath, stateDir } from "../paths";
import { errCode } from "../utils";
import {
  SCHEMA_VERSION,
  DB_BUSY_TIMEOUT,
  DB_BUSY_RETRIES,
  DB_BUSY_RETRY_DELAY_MS,
} from "../constants";
import { FILES_TABLE, UNDO_TABLE, PENDING_TABLE, META_TABLE, SCHEMA_KEY } from "./schema";

export interface Store {
  readonly db: DatabaseSync;
  readonly engine: "node:sqlite";
}

/**
 * Thrown when the persisted store was written by an incompatible extension
 * version. Unlike corruption, a version mismatch never quarantines the
 * store: upgrading (or downgrading) the extension can read it again.
 */
export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionError";
  }
}
let cachedDb: { path: string; db: DatabaseSync } | null = null;
let opening: { path: string; promise: Promise<Store> } | null = null;
let exitHandlerRegistered = false;

// Reused SharedArrayBuffer for sync sleep to avoid per-retry allocation.
const sleepSab = new Int32Array(new SharedArrayBuffer(4));

// Prepared-statement cache: per-DB Map keyed by SQL text, LRU-bounded.
// Node's DatabaseSync parses SQL on each prepare(); caching avoids repeated
// parsing for the ~10 hot statements (snapshots, journal, undo, meta).
const MAX_CACHED_PREPARED = 32;
type PreparedStatement = any;
const statementCache = new WeakMap<DatabaseSync, Map<string, PreparedStatement>>();

export function cachedPrepare(sql: string): PreparedStatement {
  const db = requireStore().db;
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map<string, PreparedStatement>();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (stmt) {
    // Refresh LRU order
    cache.delete(sql);
    cache.set(sql, stmt);
    return stmt;
  }
  stmt = db.prepare(sql);
  cache.set(sql, stmt);
  if (cache.size > MAX_CACHED_PREPARED) {
    const oldestKey = cache.keys().next().value as string;
    const oldest = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    try {
      (oldest as unknown as { finalize?: () => void }).finalize?.();
    } catch {}
  }
  return stmt;
}

function clearStatementCache(db: DatabaseSync): void {
  const cache = statementCache.get(db);
  if (cache) {
    for (const stmt of cache.values()) {
      try {
        (stmt as unknown as { finalize?: () => void }).finalize?.();
      } catch {}
    }
    cache.clear();
    statementCache.delete(db);
  }
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepSab, 0, 0, ms);
}

export function withBusyRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DB_BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === DB_BUSY_RETRIES) throw error;
      sleepSync(DB_BUSY_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export async function withBusyRetryAsync<T>(fn: () => T | Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DB_BUSY_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === DB_BUSY_RETRIES) throw error;
      await sleep(DB_BUSY_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function getUserVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    return row?.user_version ?? 0;
  } catch {
    return 0;
  }
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

type Migration = (db: DatabaseSync) => void;
const MIGRATIONS: Record<number, Migration> = {
  // Example: 2: (db) => db.exec("ALTER TABLE files ADD COLUMN new_col TEXT"),
};

function runMigrations(db: DatabaseSync, from: number, to: number): void {
  for (let v = from + 1; v <= to; v++) {
    const migrate = MIGRATIONS[v];
    if (migrate) migrate(db);
    setUserVersion(db, v);
  }
}

function openDb(storePath: string): { db: DatabaseSync } {
  const db = new DatabaseSync(storePath, { timeout: DB_BUSY_TIMEOUT });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(FILES_TABLE);
    db.exec(UNDO_TABLE);
    db.exec(PENDING_TABLE);
    db.exec(META_TABLE);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_created_at ON pending_transactions(created_at)`);
    const userVersion = getUserVersion(db);
    const versionRow = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(
      SCHEMA_KEY,
    ) as { value?: string } | undefined;
    const legacyVersion = versionRow?.value ? parseInt(versionRow.value, 10) : 0;
    const hasLegacy = versionRow?.value !== undefined;
    if ((hasLegacy && Number.isNaN(legacyVersion)) || Number.isNaN(userVersion)) {
      throw new SchemaVersionError(
        `[E_STATE_CORRUPT] Hashline state schema version ${versionRow?.value} is unsupported (expected ${SCHEMA_VERSION}). The state store was not modified; upgrade or downgrade the extension, or remove the store to start fresh.`,
      );
    }
    const effectiveVersion = Math.max(userVersion, legacyVersion);
    if (effectiveVersion > SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `[E_STATE_CORRUPT] Hashline state schema version ${effectiveVersion} is newer than supported ${SCHEMA_VERSION}. The state store was not modified; upgrade the extension or remove the store to start fresh.`,
      );
    }
    if (effectiveVersion !== 0 && effectiveVersion < SCHEMA_VERSION) {
      runMigrations(db, effectiveVersion, SCHEMA_VERSION);
    } else if (effectiveVersion === 0) {
      setUserVersion(db, SCHEMA_VERSION);
    } else if (userVersion !== SCHEMA_VERSION) {
      setUserVersion(db, SCHEMA_VERSION);
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(SCHEMA_KEY, String(SCHEMA_VERSION));
    return { db };
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Failed to quarantine corrupt hashline state file:", error);
      }
    }
  }
}

export function shutdownStore(): void {
  if (cachedDb) {
    clearStatementCache(cachedDb.db);
    try {
      cachedDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    try {
      cachedDb.db.close();
    } catch {}
    cachedDb = null;
  }
}
async function openStore(storePath: string): Promise<Store> {
  shutdownStore();
  await mkdir(stateDir(), { recursive: true });
  let opened: { db: DatabaseSync };
  try {
    opened = await withBusyRetryAsync(() => openDb(storePath));
  } catch (error) {
    if (error instanceof SchemaVersionError) throw error;
    if (!isCorruptionError(error)) throw error;
    console.error("Hashline state failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    opened = await withBusyRetryAsync(() => openDb(storePath));
  }
  if (!isHealthy(opened.db)) {
    shutdownStore();
    await quarantineStore(storePath);
    opened = await withBusyRetryAsync(() => openDb(storePath));
  }
  cachedDb = { path: storePath, db: opened.db };
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.once("exit", () => shutdownStore());
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        shutdownStore();
        process.kill(process.pid, sig);
      });
    }
  }
  return { db: opened.db, engine: "node:sqlite" };
}
export function loadStore(): Promise<Store> {
  const storePath = statePath();
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return Promise.resolve({ db: cachedDb.db, engine: "node:sqlite" });
  }
  if (opening && opening.path === storePath) {
    return opening.promise;
  }
  // Serialize openings: if another path is mid-open, wait for it to finish
  // before shutting down and opening the requested path. This avoids closing
  // a DB that may still be handling in-flight queries.
  const prior = opening?.promise;
  const doOpen = async (): Promise<Store> => {
    if (prior) {
      try {
        await prior;
      } catch {}
    }
    return openStore(storePath);
  };
  const promise = doOpen().finally(() => {
    if (opening?.path === storePath) opening = null;
  });
  opening = { path: storePath, promise };
  return promise;
}

/** Run `fn` inside a single immediate SQLite transaction (once per hybrid transaction, spec §64). */
export function withTransaction<T>(fn: () => T): T {
  const store = requireStore();
  return withBusyRetry(() => {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      store.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export function requireStore(): Store {
  if (!cachedDb) {
    throw new Error("[E_STATE_CORRUPT] Hashline state store is not open.");
  }
  return { db: cachedDb.db, engine: "node:sqlite" };
}

/** For tests: close any open store so a fresh one can be opened at a new path. */
export async function resetStoreForTests(): Promise<void> {
  shutdownStore();
  opening = null;
}

