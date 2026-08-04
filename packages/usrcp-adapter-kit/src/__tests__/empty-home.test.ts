import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAdapterConfig } from "../config-store.js";

// #192: under empty/whitespace HOME, os.homedir() returns "" (or "   ") and
// path.join(homedir, ".usrcp", filename) is RELATIVE, so an adapter's
// encrypted config would read/write into the process CWD instead of the home
// directory. getConfigPath() now routes through requireHomeDir() and refuses.

function makeStore() {
  return createAdapterConfig<{ demo_api_key: string; domain: string }>({
    adapterName: "demo",
    filename: "demo-config.json",
    fields: [
      { name: "demo_api_key", kind: "secret" },
      { name: "domain", kind: "required" },
    ],
  });
}

let origHome: string | undefined;
let origCwd: string;
let workdir: string;

beforeEach(() => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-adapterkit-emptyhome-"));
  process.chdir(workdir);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("empty/whitespace HOME refuses the adapter config path (#192)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";
    it(`getConfigPath throws and nothing is written to CWD (HOME ${label})`, () => {
      process.env.HOME = home;
      const store = makeStore();
      const before = fs.readdirSync(process.cwd());
      expect(() => store.getConfigPath()).toThrow(/HOME/);
      // A write must also refuse (getConfigPath throws before any mkdir/write)
      // rather than create a relative ".usrcp" in the CWD.
      expect(() => store.writeRaw({ demo_api_key: "sekret", domain: "d" })).toThrow(/HOME/);
      expect(fs.readdirSync(process.cwd())).toEqual(before);
    });
  }

  it("with a valid HOME the config path resolves under HOME, not CWD", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-adapterkit-realhome-"));
    process.env.HOME = home;
    try {
      const p = makeStore().getConfigPath();
      expect(p.startsWith(home)).toBe(true);
      expect(path.isAbsolute(p)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
