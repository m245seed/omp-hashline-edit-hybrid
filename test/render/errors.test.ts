import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ERROR_CODES, WARNING_CODES, E_SUSPICIOUS_PATCH } from "../../src/render/errors";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");

function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  const files = readdirSync(srcRoot, { recursive: true }) as string[];
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(srcRoot, file), "utf-8");
    for (const match of text.matchAll(/\[([EW]_[A-Z_]+)\]/g)) {
      codes.add(match[1]!);
    }
  }
  return codes;
}

describe("error and warning catalogs (spec §54, §55)", () => {
  it("every emitted [CODE] literal exists in the catalogs", () => {
    const catalog = new Set<string>([...ERROR_CODES, ...WARNING_CODES]);
    const emitted = emittedCodes();
    const missing = [...emitted].filter((code) => !catalog.has(code));
    expect(missing, `codes emitted in src but absent from the catalogs: ${missing.join(", ")}`).toEqual([]);
  });

  it("every catalog code is actually emitted somewhere in src", () => {
    const emitted = emittedCodes();
    const dead = [...ERROR_CODES, ...WARNING_CODES].filter((code) => !emitted.has(code));
    expect(dead, `catalog entries never emitted (dead catalog entries): ${dead.join(", ")}`).toEqual([]);
  });

  it("error and warning codes do not overlap", () => {
    const overlap = ERROR_CODES.filter((code) => (WARNING_CODES as readonly string[]).includes(code));
    expect(overlap).toEqual([]);
  });

  it("exposes E_SUSPICIOUS_PATCH as alias for backward compatibility", () => {
    expect(E_SUSPICIOUS_PATCH).toBe("E_DISPLAY_LIKE_CONTENT");
  });
});
