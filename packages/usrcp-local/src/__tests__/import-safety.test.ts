import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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

  // Regression: the `usrcp` umbrella package's bin is ESM and runs the CLI via
  // `import { runCli } from "usrcp-local"; runCli()`. When the require.main
  // guard from #181 landed while the umbrella still relied on a bare
  // `import "usrcp-local"` side effect, `npm i -g usrcp` became a silent no-op
  // (every subcommand printed nothing and exited 0). runCli() must be an
  // explicit, callable entry that dispatches. This shim mirrors the umbrella
  // bin exactly (a real .mjs file so process.argv[2] is the command).
  it("the umbrella ESM entry (import { runCli }) dispatches the CLI", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-umbrella-"));
    const shim = path.join(home, "umbrella.mjs");
    fs.writeFileSync(shim, `import { runCli } from ${JSON.stringify(pathToFileURL(distIndex).href)};\nrunCli();\n`);
    // The banner + usage print to stderr (console.error), so capture both
    // streams. Before the fix this produced nothing and still exited 0.
    const res = spawnSync(process.execPath, [shim, "--help"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).toContain("Usage: usrcp");
  });

  // Complement to the require() test above for the ESM path: importing the
  // module (without calling runCli) must not dispatch or create a ledger.
  it("ESM import of the entrypoint (without runCli) neither dispatches nor creates a ledger", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-esm-importsafe-"));
    const shim = path.join(home, "importonly.mjs");
    fs.writeFileSync(shim, `await import(${JSON.stringify(pathToFileURL(distIndex).href)});\n`);
    const out = execFileSync(process.execPath, [shim], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(out).toBe("");
    const strayLedger = path.join(home, ".usrcp", "users", "default", "ledger.db");
    expect(fs.existsSync(strayLedger)).toBe(false);
  });
});
