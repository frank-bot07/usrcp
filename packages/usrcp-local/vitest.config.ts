import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: 30_000,
    setupFiles: ["./src/__tests__/vitest-setup.ts"],
  },
});
