import { createHash } from "crypto";

export function isRec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `[E_BAD_SHAPE] ${label} contains unknown or unsupported fields: ${unknown.join(", ")}.`,
    );
  }
}

export function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("[E_ABORTED] Operation aborted.");
}

export function errCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function debugLog(message: string, ...args: unknown[]): void {
  if (process.env.HASHLINE_DEBUG) {
    console.error(`[hashline:debug] ${message}`, ...args);
  }
}

export function normPosInt(
  value: unknown,
  name: string,
  label = "Read request",
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `[E_BAD_SHAPE] ${label} field "${name}" must be a positive integer.`,
    );
  }
  return value;
}
