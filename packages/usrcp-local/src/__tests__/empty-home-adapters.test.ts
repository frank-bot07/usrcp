import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addTerminalAdapter, ALL_TARGETS } from "../adapters/terminal/index.js";
import { getBackupDir } from "../adapters/terminal/shared.js";
import { getExternalRegistryPath } from "../adapters/registry.js";

/**
 * Regression for #174. #165 guarded only the two paths init builds on
 * (getUsrcpBaseDir, getClientConfigPath), but ~13 adapter/context/registry
 * sites still called homedir()/os.homedir() directly. Under empty or whitespace
 * HOME, os.homedir() returns "" (or "   "), and join("", ".codex") === ".codex"
 * -- a RELATIVE path -- so `usrcp adapter add terminal --all` wrote stray
 * `.codex/config.toml`, `.cursor/`, ledger-derived `.usrcp/CONTEXT.md`, etc.
 * into the process CWD instead of the home directory.
 *
 * Every home-anchored adapter path now routes through the same requireHomeDir()
 * guard (via terminal/shared.ts homeDir() and registry.ts), so a broken HOME
 * refuses instead of writing relative. This drives the real dispatcher over
 * ALL terminal targets to prove no target writes to CWD.
 */
const USRCP_BIN = "/usr/local/bin/usrcp";

let origHome: string | undefined;
let origCwd: string;
let workdir: string;

beforeEach(() => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  // Run inside a fresh empty dir: any relative (unguarded) write lands here and
  // is trivially detectable, and isolated from the real repo checkout.
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-emptyhome-cwd-"));
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("empty/whitespace HOME refuses home-anchored adapter writes (#174)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";

    it(`addTerminalAdapter over all targets fails each and writes nothing to CWD (HOME ${label})`, async () => {
      process.env.HOME = home;
      const before = fs.readdirSync(process.cwd());

      // The confirmed trigger: `usrcp adapter add terminal --all`.
      const results = await addTerminalAdapter(ALL_TARGETS, USRCP_BIN);

      expect(results.length).toBe(ALL_TARGETS.length);
      for (const r of results) {
        // Pre-fix, each target wrote a relative dotdir into CWD and returned ok.
        expect(r.ok).toBe(false);
        expect(String(r.error)).toMatch(/HOME/);
      }
      // No stray `.codex`, `.cursor`, `.usrcp`, etc. leaked into the CWD.
      expect(fs.readdirSync(process.cwd())).toEqual(before);
    });

    it(`getBackupDir and getExternalRegistryPath throw (HOME ${label})`, () => {
      process.env.HOME = home;
      expect(() => getBackupDir()).toThrow(/HOME/);
      expect(() => getExternalRegistryPath()).toThrow(/HOME/);
    });
  }

  it("with a valid HOME, adapter registration writes into HOME, not CWD", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-emptyhome-real-"));
    process.env.HOME = home;
    try {
      const before = fs.readdirSync(process.cwd());
      const codexOnly = ALL_TARGETS.filter((t) => t === "codex");
      const [res] = await addTerminalAdapter(codexOnly, USRCP_BIN);

      expect(res.ok).toBe(true);
      expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
      // Nothing leaked into CWD on the happy path either.
      expect(fs.readdirSync(process.cwd())).toEqual(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
