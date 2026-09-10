import { mkdirSync, writeFileSync, readdirSync } from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withStateDir } from "../support/env";

import { loadStore, resetStoreForTests, shutdownStore, isCorruptionError, withBusyRetry, withBusyRetryAsync } from "../../src/state/database";
import { statePath, configDir } from "../../src/paths";

;

beforeEach(() => {
  withStateDir();
});

afterEach(async () => {
  await resetStoreForTests();
});

describe("persistent store robustness (spec §48, §49)", () => {
  it("creates the store under the XDG config dir", async () => {
    await loadStore();
    expect(require("fs").existsSync(statePath())).toBe(true);
  });

  it("quarantines a corrupted store and creates a clean one", async () => {
    const dir = configDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), "this is not a sqlite database at all", "utf-8");
    const store = await loadStore();
    // A fresh healthy store was created and the corrupt file quarantined.
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
    expect(store.db.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  });

  it("rejects an unsupported schema version", async () => {
    const store = await loadStore();
    store.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    shutdownStore();
    await expect(loadStore()).rejects.toThrow(/E_STATE_CORRUPT/);
  });

  it("detects SQLite corruption errors", () => {
    const err = Object.assign(new Error("database disk image is malformed"), { errcode: 11 });
    expect(isCorruptionError(err)).toBe(true);
    expect(isCorruptionError(Object.assign(new Error("nope"), { code: "SQLITE_NOTADB" }))).toBe(true);
    expect(isCorruptionError(new Error("ordinary"))).toBe(false);
  });

  it("checkpoints and closes on shutdown", async () => {
    const store = await loadStore();
    store.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run();
    shutdownStore();
    expect(store.db.isOpen).toBe(false);
  });
});

describe("busy retry (spec §49)", () => {
  it("retries busy operations and succeeds", () => {
    let calls = 0;
    const result = withBusyRetry(() => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error("database is locked"), { errcode: 5 });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after bounded retries", () => {
    expect(() =>
      withBusyRetry(() => {
        throw Object.assign(new Error("database is locked"), { errcode: 6 });
      }),
    ).toThrow(/locked/);
  });

  it("does not retry non-busy errors", () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(() => {
        calls++;
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(calls).toBe(1);
  });

  it("retries busy operations asynchronously and succeeds", async () => {
    let calls = 0;
    const result = await withBusyRetryAsync(async () => {
      calls++;
      if (calls < 2) {
        throw Object.assign(new Error("database is locked"), { errcode: 5 });
      }
      return "async-ok";
    });
    expect(result).toBe("async-ok");
    expect(calls).toBe(2);
  });

  it("gives up after bounded async retries", async () => {
    await expect(
      withBusyRetryAsync(() => {
        throw Object.assign(new Error("database is locked"), { errcode: 6 });
      }),
    ).rejects.toThrow(/locked/);
  });
});
