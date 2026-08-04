import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getUsrcpDir, getConfigPath, getNMManifestPath } from "../config.js";

// #192: every extension path funnels through getUsrcpDir() (the ~/.usrcp
// config + native-host launcher) or getNMManifestPath() (the Chrome native-
// messaging manifest); both now route through requireHomeDir(), so an empty
// HOME refuses instead of writing a relative tree into the CWD.

let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe("empty/whitespace HOME refuses extension paths (#192)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";
    it(`getUsrcpDir / getConfigPath / getNMManifestPath throw (HOME ${label})`, () => {
      process.env.HOME = home;
      expect(() => getUsrcpDir()).toThrow(/HOME/);
      expect(() => getConfigPath()).toThrow(/HOME/);
      // getNMManifestPath only builds a home-anchored path on darwin/linux.
      if (process.platform === "darwin" || process.platform === "linux") {
        expect(() => getNMManifestPath()).toThrow(/HOME/);
      }
    });
  }

  it("with a valid HOME getUsrcpDir is absolute under HOME", () => {
    process.env.HOME = "/tmp/usrcp-ext-home-fixture";
    expect(getUsrcpDir()).toBe("/tmp/usrcp-ext-home-fixture/.usrcp");
  });
});
