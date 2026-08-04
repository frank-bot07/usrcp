import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireHomeDir } from "../home.js";
import { resolveUsrcpBinary, BinaryNotFoundError } from "../mcp-client.js";

// #192: usrcp-vscode has no usrcp-core dependency (that would pull the ledger
// and node:sqlite into the extension bundle), so it carries a local
// requireHomeDir() guard. Under empty HOME the reveal path refuses, and the
// read-only binary lookup SKIPS its ~/.local candidate (returning null) rather
// than probing a CWD-relative ".local/bin/usrcp".

let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe("requireHomeDir guard (#192)", () => {
  for (const home of ["", "   "]) {
    const label = home === "" ? "empty" : "whitespace";
    it(`throws under ${label} HOME`, () => {
      process.env.HOME = home;
      expect(() => requireHomeDir()).toThrow(/HOME/);
    });
  }

  it("returns an absolute path under a valid HOME", () => {
    process.env.HOME = "/tmp/usrcp-vscode-home-fixture";
    expect(requireHomeDir()).toBe("/tmp/usrcp-vscode-home-fixture");
  });
});

describe("resolveUsrcpBinary skips the home-relative candidate under empty HOME (#192)", () => {
  it("never probes a CWD-relative .local/bin/usrcp", () => {
    process.env.HOME = "";
    let result: string | undefined;
    let err: unknown;
    try {
      result = resolveUsrcpBinary();
    } catch (e) {
      err = e;
    }
    if (err) {
      // BinaryNotFoundError's message lists every path it searched. With the
      // fix the ~/.local candidate is skipped, so ".local/bin/usrcp" never
      // appears; pre-fix it appeared as a relative join of "".
      expect(err).toBeInstanceOf(BinaryNotFoundError);
      expect((err as Error).message).not.toContain(".local/bin/usrcp");
    } else if (result) {
      // If a real usrcp exists on this machine it is at an absolute path.
      expect(result.startsWith("/")).toBe(true);
    }
  });
});
