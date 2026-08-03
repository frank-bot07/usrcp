import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every suite here writes through the AES-256-GCM ledger, so per-test cost
    // is dominated by scrypt rather than by the logic under test. Matches the
    // budget usrcp-core and the other configured packages already use; without
    // a config file at all, these packages were still on vitest's 5s default.
    testTimeout: 30_000,
  },
});
