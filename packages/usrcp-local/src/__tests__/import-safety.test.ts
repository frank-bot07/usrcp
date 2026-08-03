import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Regression: importing the published usrcp-local entrypoint must be a pure
// module load. Before the require.main === module guard, the top-level command
// switch ran on import and its default branch called cmdServe(), which started
// the MCP server and created ~/.usrcp/users/default/ledger.db as a side effect
// (and exited nonzero on failure via the unhandled process.exit that made
// clients.test.ts leave `npm test` with a nonzero code).
describe("import safety", () => {
  const distIndex = path.resolve(__dirname, "..", "..", "dist", "index.js");

  beforeAll(() => {
    // Tests may run against a stale/absent dist locally; ensure it exists so
    // the assertion is never a silent skip. CI already builds before testing.
    if (!fs.existsSync(distIndex)) {
      execFileSync("npm", ["run", "build"], { cwd: path.resolve(__dirname, "..", ".."), stdio: "ignore" });
    }
  });

  it("require() of the entrypoint neither dispatches nor creates a ledger", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-importsafe-"));
    // Exits 0 with no dispatch; a thrown/started server or process.exit(1)
    // would make execFileSync throw.
    execFileSync(process.execPath, ["-e", `require(${JSON.stringify(distIndex)})`], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "ignore",
      timeout: 15_000,
    });
    const strayLedger = path.join(home, ".usrcp", "users", "default", "ledger.db");
    expect(fs.existsSync(strayLedger)).toBe(false);
  });
});
