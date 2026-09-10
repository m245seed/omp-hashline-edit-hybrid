import { homedir } from "os";
import { isAbsolute, resolve as resolvePath, join, dirname } from "path";

function homeBase(): string {
  if (process.platform === "win32") {
    // Git-bash sets HOME to a POSIX-style path ("/c/Users/...") that is
    // meaningless to Win32 APIs - os.homedir() is always right here.
    return homedir();
  }
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  // XDG_CONFIG_HOME must be honored on every platform: it is how tests (and
  // sandboxed sessions) isolate the persistent store. Ignoring it on win32
  // made the test suite read and write the live user store.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return join(homeBase(), ".config");
}

export function configDir(): string {
  return join(configBase(), "omp-hashline-edit-hybrid");
}

export function statePath(): string {
  return join(configDir(), "state.sqlite");
}

export function stateDir(): string {
  return dirname(statePath());
}

function expand(filePath: string): string {
  const home = homeBase();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return home + filePath.slice(1);
  return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
