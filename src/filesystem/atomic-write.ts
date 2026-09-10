/**
 * Atomic write (spec §29, §44–§46).
 *
 * Normal files are replaced via `.tmp-<uuid>` + fsync + rename + parent-dir
 * fsync. Hard-linked files (nlink > 1) are written in place to preserve the
 * shared inode, with a `W_HARDLINK_NONATOMIC` warning — the write still
 * rechecks the checksum beforehand and fsyncs after (spec §44). Mode bits
 * are preserved across the atomic rename (spec §46); ACLs, xattrs, and
 * ownership are not promised. There is no silent non-atomic fallback:
 * a failed atomic replacement reports E_ATOMIC_REPLACE_FAILED (spec §45).
 */

import { randomUUID } from "crypto";
import { lstat, open, readdir, rename, rm, stat, type FileHandle } from "fs/promises";
import { dirname, join, resolve as resolvePath } from "path";
import { MAX_BYTES, STALE_TEMP_MS } from "../constants";
import { errCode } from "../utils";
import { resolveTarget } from "./resolve-target";

const TEMP_PREFIX = ".tmp-";
const TEMP_UUID_RE =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sweptDirs = new Set<string>();

export function clearSweptDirsForTests(): void {
  sweptDirs.clear();
}
async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  // Cap cache to avoid unbounded growth in long sessions touching many dirs
  if (sweptDirs.size > 500) {
    const oldest = sweptDirs.values().next().value as string | undefined;
    if (oldest !== undefined) sweptDirs.delete(oldest);
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (now - stats.mtimeMs > STALE_TEMP_MS) {
          await rm(tempPath, { force: true });
        }
      } catch {}
    }
  } catch {}
}
export async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyOpenHandle(
  handle: FileHandle,
  targetPath: string,
  expected: Uint8Array,
): Promise<void> {
  const info = await handle.stat();
  let equal = info.size === expected.byteLength;
  if (equal && info.size > 0) {
    const chunkSize = 64 * 1024;
    const buffer = Buffer.alloc(Math.min(chunkSize, info.size));
    let offset = 0;
    while (offset < info.size) {
      const count = Math.min(chunkSize, info.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, count, offset);
      if (
        bytesRead !== count ||
        !buffer.subarray(0, count).equals(expected.subarray(offset, offset + count))
      ) {
        equal = false;
        break;
      }
      offset += count;
    }
  }
  const pathInfo = await lstat(targetPath).catch(() => undefined);
  if (
    !pathInfo?.isFile() ||
    pathInfo.dev !== info.dev ||
    pathInfo.ino !== info.ino ||
    pathInfo.size !== info.size
  ) {
    equal = false;
  }
  if (!equal) {
    throw new Error(
      `[E_FILE_CHANGED] The file ${targetPath} changed before the in-place write. Nothing was modified.`,
    );
  }
}

export interface TargetInfo {
  targetPath: string;
  mode?: number;
  hardlink: boolean;
}

/** Resolve the real target and inspect it for the commit protocol. */
export async function inspectTarget(path: string): Promise<TargetInfo> {
  const targetPath = await resolveTarget(path);
  try {
    const info = await stat(targetPath);
    return {
      targetPath,
      mode: info.mode & 0o7777,
      hardlink: info.nlink > 1,
    };
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") {
      return { targetPath, hardlink: false };
    }
    throw error;
  }
}

/**
 * Phase 4 — prepare temp file: same directory, exclusive create, write,
 * apply mode, fsync.
 */
export async function prepareTempWrite(
  targetPath: string,
  content: Uint8Array,
  mode?: number,
): Promise<string> {
  const dir = dirname(targetPath);
  await sweepStaleTemps(dir);
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
    await handle.sync();
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch {}
    try {
      await rm(tempPath, { force: true });
    } catch {}
    throw error;
  }
  await handle.close();
  return tempPath;
}

/** Error raised after rename succeeded but directory durability failed. */
export class CommitAfterRenameError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super(
      `Directory synchronization failed after the replacement was committed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CommitAfterRenameError";
  }
}

/** Phase 6 — commit: rename temp over target, then fsync the parent dir. */
export async function commitTempFile(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await rename(tempPath, targetPath);
  try {
    await syncDir(dir);
  } catch (error: unknown) {
    // The rename is durable from the namespace's point of view even when the
    // directory fsync fails. Preserve the journal so startup recovery can
    // finalize state from the committed file rather than deleting evidence.
    throw new CommitAfterRenameError(error);
  }
}

export async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch {}
}

/** Phase 5 — precommit verification (spec §29, §33). */
export async function precommitVerify(
  path: string,
  originalTarget: string,
  rawBefore: Buffer,
  expectAbsent = false,
): Promise<void> {
  const currentTarget = await resolveTarget(path);
  if (resolvePath(currentTarget) !== resolvePath(originalTarget)) {
    throw new Error(
      `[E_PATH_CHANGED] The target of ${path} changed during transaction preparation (it now resolves to ${currentTarget}). Nothing was modified.`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(currentTarget, "r");
  } catch (error: unknown) {
    if (expectAbsent && errCode(error) === "ENOENT") {
      // New-file write: the target must still be absent at commit time.
      return;
    }
    if (errCode(error) === "ENOENT") {
      throw new Error(
        `[E_FILE_CHANGED] The file ${path} disappeared during transaction preparation. Nothing was modified.`,
      );
    }
    throw error;
  }
  if (expectAbsent) {
    await handle.close();
    throw new Error(
      `[E_FILE_CHANGED] The file ${path} appeared on disk during transaction preparation. Nothing was modified.`,
    );
  }
  let equal = false;
  try {
    const info = await handle.stat();
    if (info.size > MAX_BYTES) {
      throw new Error(
        `[E_FILE_TOO_LARGE] The file ${path} is ${info.size} bytes, which exceeds the ${MAX_BYTES} byte limit. Nothing was modified.`,
      );
    }
    // Fast-path size mismatch: content cannot be equal
    if (info.size !== rawBefore.length) {
      equal = false;
    } else if (info.size === 0) {
      equal = true;
    } else {
      // Chunked compare to avoid allocating a second full-file buffer for large files
      const CHUNK = 64 * 1024;
      let offset = 0;
      let matches = true;
      const buf = Buffer.alloc(Math.min(CHUNK, info.size));
      while (offset < info.size) {
        const toRead = Math.min(CHUNK, info.size - offset);
        const { bytesRead } = await handle.read(buf, 0, toRead, offset);
        if (
          bytesRead !== toRead ||
          !rawBefore
            .subarray(offset, offset + toRead)
            .equals(buf.subarray(0, toRead))
        ) {
          matches = false;
          break;
        }
        offset += toRead;
      }
      equal = matches;
    }
    // The file may have grown after the initial stat while it was being
    // compared. A final size check prevents accepting an appended write.
    const finalInfo = await handle.stat();
    if (finalInfo.size !== info.size) equal = false;
    try {
      const pathInfo = await lstat(currentTarget);
      if (
        !pathInfo.isFile() ||
        pathInfo.dev !== info.dev ||
        pathInfo.ino !== info.ino ||
        pathInfo.size !== info.size
      ) {
        equal = false;
      }
    } catch {
      equal = false;
    }
  } finally {
    await handle.close();
  }
  if (!equal) {
    throw new Error(
      `[E_FILE_CHANGED] The file changed on disk during transaction preparation. Nothing was modified.`,
    );
  }
}

/**
 * Hard-link in-place write (spec §44): when expectedBefore is supplied,
 * compare the already-open handle immediately before writing. This closes the
 * precommit-check/write race for shared inodes.
 */
export async function writeInPlace(
  targetPath: string,
  content: Uint8Array,
  mode?: number,
  createIfMissing = true,
  expectedBefore?: Uint8Array,
): Promise<void> {
  // Use r+ to avoid O_TRUNC before write. Commit callers disable creation so
  // a deleted hardlink cannot be silently recreated as a new inode.
  let handle: FileHandle;
  try {
    handle = await open(targetPath, "r+");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") {
      if (!createIfMissing) {
        throw new Error(
          `[E_FILE_CHANGED] The target ${targetPath} disappeared before the in-place write. Nothing was modified.`,
        );
      }
      try {
        handle = await open(targetPath, "wx", mode ?? 0o666);
      } catch (createError: unknown) {
        if (errCode(createError) === "EEXIST") {
          throw new Error(
            `[E_FILE_CHANGED] The target ${targetPath} appeared before the in-place write. Nothing was modified.`,
          );
        }
        throw createError;
      }
    } else {
      throw error;
    }
  }
  try {
    if (expectedBefore !== undefined) {
      await verifyOpenHandle(handle, targetPath, expectedBefore);
    }
    await handle.writeFile(content);
    // If new content is shorter than old file, truncate the remainder.
    const current = await handle.stat();
    if (current.size > content.byteLength) {
      await handle.truncate(content.byteLength);
    }
    await handle.sync();
    if (mode !== undefined) {
      await handle.chmod(mode);
    }
  } finally {
    await handle.close();
  }
}
