import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfigPath, getClaudeProjectsDir } from "../config.js";

// #192: both home-anchored paths route through requireHomeDir(), so an empty
// or whitespace HOME refuses instead of producing a relative ".usrcp" /
// ".claude" that would read/write into the process CWD.

let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe("empty/whitespace HOME refuses config paths (#192)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";
    it(`getConfigPath and getClaudeProjectsDir throw (HOME ${label})`, () => {
      process.env.HOME = home;
      expect(() => getConfigPath()).toThrow(/HOME/);
      expect(() => getClaudeProjectsDir()).toThrow(/HOME/);
    });
  }

  it("with a valid HOME both paths are absolute under HOME", () => {
    process.env.HOME = "/tmp/usrcp-cc-home-fixture";
    expect(getConfigPath().startsWith("/tmp/usrcp-cc-home-fixture")).toBe(true);
    expect(getClaudeProjectsDir().startsWith("/tmp/usrcp-cc-home-fixture")).toBe(true);
  });
});
