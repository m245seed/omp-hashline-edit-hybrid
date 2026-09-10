/** FNV-1a 32-bit (spec §51). Synchronous, dependency-free. Anchor
 * determinism is per-extension-version: hash quality is irrelevant to
 * uniqueness because allocator probing resolves collisions. */
export function hashLine32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
