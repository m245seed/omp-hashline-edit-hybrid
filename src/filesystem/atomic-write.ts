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
import { lstat, open, readdir, rename, rm, stat } from "fs/promises";
import { dirname, join } from "path";
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
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
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

/** Phase 6 — commit: rename temp over target, then fsync the parent dir. */
export async function commitTempFile(
  tempPath: string,
  targetPath: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await rename(tempPath, targetPath);
  await syncDir(dir);
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
  if (currentTarget !== originalTarget) {
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
 * Hard-link in-place write (spec §44): recheck checksum before writing,
 * write through one open handle without truncating before the new content
 * is fully written, then truncate if the new content is shorter.
 * This avoids exposing concurrent readers to a temporarily empty file.
 */
export async function writeInPlace(
  targetPath: string,
  content: Uint8Array,
  mode?: number,
  createIfMissing = true,
): Promise<void> {
  // Use r+ to avoid O_TRUNC before write. Commit callers disable creation so
  // a deleted hardlink cannot be silently recreated as a new inode.
  let handle: Awaited<ReturnType<typeof open>>;
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
        // Exclusive creation prevents a target that appears between the
        // failed r+ open and this fallback from being truncated.
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
    await handle.writeFile(content);
    // If new content is shorter than old file, truncate the remainder.
    // Failures must propagate: swallowing one here would leave the file as
    // new content + stale tail while the edit reports success (spec §45).
    const stat = await handle.stat();
    if (stat.size > content.byteLength) {
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
