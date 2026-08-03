import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    // The false-pass-guard mutation harness rewrites source files in
    // place while it spawns a child vitest. If other test files were
    // running in parallel, they would see the half-applied mutation and
    // fail spuriously. Serializing file execution avoids the race.
    // Stream's suite is small (~75 tests, ~2s), so the cost is minor.
    fileParallelism: false,
  },
});
