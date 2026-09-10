import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Point the persistent state store at a throwaway directory. The store
 * path is derived from XDG_CONFIG_HOME at call time, so tests can run
 * isolated from the real user configuration.
 */
export function withStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-hybrid-state-"));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

export function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
