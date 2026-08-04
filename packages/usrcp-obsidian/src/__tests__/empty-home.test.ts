import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfigPath } from "../config.js";

// #192: the obsidian config write path routes through requireHomeDir(), so an
// empty/whitespace HOME refuses instead of producing a relative ".usrcp" that
// would write the config into the process CWD. (The interactive `~`-expansion
// sites in setup.ts use the same guard, and only demand a home when the user's
// path actually starts with `~`.)

let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe("empty/whitespace HOME refuses the obsidian config path (#192)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";
    it(`getConfigPath throws (HOME ${label})`, () => {
      process.env.HOME = home;
      expect(() => getConfigPath()).toThrow(/HOME/);
    });
  }

  it("with a valid HOME the config path is absolute under HOME", () => {
    process.env.HOME = "/tmp/usrcp-obs-home-fixture";
    const p = getConfigPath();
    expect(p.startsWith("/tmp/usrcp-obs-home-fixture")).toBe(true);
  });
});
