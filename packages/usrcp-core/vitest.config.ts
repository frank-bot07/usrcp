import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["./src/__tests__/vitest-setup.ts"],
    // This suite is scrypt-bound: key derivation, rotation and tamper-capping
    // each re-encrypt real rows, and the file totals ~65s of test time. On a
    // loaded CI runner individual tests land well past vitest's 5s default —
    // three different ones have timed out so far, on PRs that changed nothing
    // related. A 5s budget for work that is deliberately expensive by design
    // produces red badges that mean nothing, so the number is raised rather
    // than patched test by test.
    testTimeout: 30_000,
  },
});
