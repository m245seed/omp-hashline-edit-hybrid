/**
 * Symlink-aware target resolution (spec §43).
 *
 * Mutations follow symlinks rather than replacing the symlink itself, so
 * editing `src/config.ts` changes the real target while preserving the
 * symbolic link. Symlink loops are detected and reported as ELOOP.
 * Note: visitedSymlinks tracks visited paths (matching Node realpath semantics)
 * rather than (device, inode) pairs.
 *
 * Also re-exports the per-file mutation serialization helper so that
 * filesystem callers have a single filesystem import surface.
 */

import { lstat, readlink } from "fs/promises";
import { dirname, join, parse, resolve, sep } from "path";
import { errCode } from "../utils";
const mutationQueues = new Map<string, Promise<unknown>>();
/**
 * Per-file promise queue serializing whole-file mutations (spec §43-§46).
 *
 * Local fallback: `@oh-my-pi/pi-coding-agent` does not export
 * `withFileMutationQueue`, so the ordering guarantee lives here. Same
 * contract: callbacks for one path run strictly in call order, a rejection
 * never breaks the chain for later callers, and the caller's own
 * result/rejection propagates unchanged.
 */
export function withFileMutationQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutationQueues.get(path) ?? Promise.resolve();
  const run = (async (): Promise<T> => {
    await prev.catch(() => undefined);
    return fn();
  })();
  const settled: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(path, settled);
  void settled.then(() => {
    if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
  });
  return run;
}

export async function resolveTarget(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resParts(
    currentPath: string,
    remainingParts: string[],
  ): Promise<string> {
    if (remainingParts.length === 0) {
      return currentPath;
    }
    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart!);
    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resParts(candidatePath, tail);
      }
      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(
          `Too many symbolic links while resolving ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);
      const linkTargetPath = resolve(
        dirname(candidatePath),
        await readlink(candidatePath),
      );
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resParts(parse(linkTargetPath).root, [
        ...targetParts,
        ...tail,
      ]);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }
  return resParts(root, parts);
}
