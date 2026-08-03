import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Regression for #178. usrcp-stream is an optional peer dependency, and
 * loadStreamTools must distinguish four cases that a naive MODULE_NOT_FOUND
 * check conflates:
 *
 *   1. NOT INSTALLED  -> silent skip, no stream tools, no diagnostic.
 *   2. INSTALLED, OK  -> registerStreamTools runs and the stream_* tools appear.
 *   3. INSTALLED, BROKEN (e.g. a MODULE_NOT_FOUND from usrcp-stream's OWN
 *      transitive import) -> the error is LOGGED, never swallowed, and the
 *      local server keeps running.
 *   4. INSTALLED, ENTRY FILE MISSING (package.json present but dist/register.js
 *      gone) -> also LOGGED, not silent. Resolving the entry throws
 *      MODULE_NOT_FOUND here EXACTLY as in case (1), so presence must be proven
 *      via package.json, which does not depend on the entry file.
 *
 * A single MODULE_NOT_FOUND check makes cases (3) and (4) indistinguishable
 * from (1): a missing import or missing entry silently erased every stream
 * tool. We drive the built server through a child process so require runs
 * against the REAL "usrcp-stream/..." specifiers, resolved via a stubbed
 * usrcp-stream placed on NODE_PATH. A fake server records the tool names the
 * stub registers, which is how we assert "installed registration yields the
 * stream_* tools" without a full stdio MCP handshake.
 */
describe("optional usrcp-stream loading (#178)", () => {
  const pkgRoot = path.resolve(__dirname, "..", "..");
  const distServer = path.join(pkgRoot, "dist", "server.js");
  let harness: string;
  let harnessDir: string;

  beforeAll(() => {
    // CI builds before testing; locally the dist may be stale/absent, so build
    // rather than let the assertions silently skip on a missing artifact.
    if (!fs.existsSync(distServer)) {
      execFileSync("npm", ["run", "build"], { cwd: pkgRoot, stdio: "ignore" });
    }
    harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-harness-"));
    harness = path.join(harnessDir, "harness.cjs");
    // Calls loadStreamTools with a fake server that records registered tool
    // names, then prints the outcome as JSON. Any thrown error propagates as a
    // nonzero exit, which spawnSync surfaces (proving loadStreamTools does not
    // take the server down for an optional peer).
    fs.writeFileSync(
      harness,
      `const distServer = process.argv[2];
const { loadStreamTools } = require(distServer);
const tools = [];
const fakeServer = {
  registerTool: (name) => { tools.push(name); return {}; },
  tool: (name) => { tools.push(name); return {}; },
};
const shutdown = loadStreamTools(fakeServer, {
  masterKey: Buffer.alloc(32, 7),
  ledger: {},
  userDir: ${JSON.stringify(harnessDir)},
  serveOptions: {},
});
process.stdout.write(JSON.stringify({ tools, shutdown: typeof shutdown === "function" }));
`
    );
  });

  // Build a stub usrcp-stream package on disk and return the node_modules dir
  // to put on NODE_PATH so the built server resolves it. package.json is always
  // written (that is how presence is proven); pass registerJs=null to simulate
  // an installed package whose published dist/register.js entry file is missing.
  function makeStreamStub(registerJs: string | null): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-stub-"));
    const nodeModules = path.join(root, "node_modules");
    const pkgDist = path.join(nodeModules, "usrcp-stream", "dist");
    fs.mkdirSync(pkgDist, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "usrcp-stream", "package.json"),
      JSON.stringify({ name: "usrcp-stream", version: "0.0.0", main: "dist/register.js" })
    );
    if (registerJs !== null) {
      fs.writeFileSync(path.join(pkgDist, "register.js"), registerJs);
    }
    return nodeModules;
  }

  function run(nodePath: string): { status: number; out: any; stderr: string } {
    const r = spawnSync(process.execPath, [harness, distServer], {
      // NODE_PATH="" for the absence case; the worktree has no usrcp-stream, so
      // an empty NODE_PATH leaves the specifier genuinely unresolvable.
      env: { ...process.env, NODE_PATH: nodePath },
      encoding: "utf8",
    });
    return {
      status: r.status ?? -1,
      out: r.stdout ? JSON.parse(r.stdout) : null,
      stderr: r.stderr ?? "",
    };
  }

  it("registers stream_* tools when an installed usrcp-stream loads cleanly", () => {
    const nodeModules = makeStreamStub(
      `exports.registerStreamTools = function (server) {
         server.registerTool("stream_probe", {}, () => ({}));
         return { shutdown: () => {} };
       };`
    );
    const r = run(nodeModules);
    expect(r.status).toBe(0);
    expect(r.out.tools).toContain("stream_probe");
    expect(r.out.shutdown).toBe(true);
    // A clean load must not print the failure diagnostic.
    expect(r.stderr).not.toContain("failed to load or register");
  });

  it("reports (not swallows) a nested MODULE_NOT_FOUND inside an installed usrcp-stream", () => {
    // The entry resolves, but loading it throws MODULE_NOT_FOUND from one of
    // usrcp-stream's OWN imports. Pre-#178 this was indistinguishable from
    // "not installed" and the tools vanished silently.
    const nodeModules = makeStreamStub(
      `require("usrcp-stream-missing-transitive-dep-xyz");
       exports.registerStreamTools = function () { return { shutdown: () => {} }; };`
    );
    const r = run(nodeModules);
    // Server survives an optional peer's breakage.
    expect(r.status).toBe(0);
    // No stream tools registered, because loading failed before registration.
    expect(r.out.tools).toHaveLength(0);
    // The failure is surfaced, and the specific nested module is named.
    expect(r.stderr).toContain("failed to load or register");
    expect(r.stderr).toContain("usrcp-stream-missing-transitive-dep-xyz");
  });

  it("reports (not swallows) an installed usrcp-stream whose entry file is missing", () => {
    // package.json present (the package IS installed) but dist/register.js is
    // gone. Resolving the entry throws MODULE_NOT_FOUND here exactly as for a
    // truly-absent package, so presence is proven via package.json and this
    // failure must still be logged, not silently skipped.
    const nodeModules = makeStreamStub(null);
    const r = run(nodeModules);
    expect(r.status).toBe(0);
    expect(r.out.tools).toHaveLength(0);
    expect(r.stderr).toContain("failed to load or register");
  });

  it("skips silently when usrcp-stream is not installed", () => {
    const r = run("");
    expect(r.status).toBe(0);
    expect(r.out.tools).toHaveLength(0);
    expect(r.out.shutdown).toBe(false);
    // Absence is the ONLY silent path: no [usrcp] diagnostic at all.
    expect(r.stderr).not.toContain("[usrcp]");
  });
});
