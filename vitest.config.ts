import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The property/fuzz tests run for tens of seconds, and longer still under
    // coverage instrumentation; keep generous headroom so `test:coverage`
    // cannot fail on timing.
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});
