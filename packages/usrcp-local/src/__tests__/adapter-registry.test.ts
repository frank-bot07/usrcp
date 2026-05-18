/**
 * Tests for the marketplace-style adapter registry.
 *
 * Covers:
 *   - BUILTIN_ADAPTERS contract: every known in-tree adapter is present
 *     with a manifest that matches the previously-hardcoded behavior
 *     (encryption gates, hidden flag, macOS gate).
 *   - External adapter loading from `~/.usrcp/adapters.json`:
 *     happy path, malformed JSON, missing fields, shadowing.
 *   - getMasterKeyRequiringAdapterValues / getRotateKeyAdapterValues
 *     return the right derived sets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BUILTIN_ADAPTERS,
  type AdapterManifest,
  loadExternalAdapters,
  getRegisteredAdapters,
  findAdapter,
  getMasterKeyRequiringAdapterValues,
  getRotateKeyAdapterValues,
  resolveAdapterPackageName,
} from "../adapters/registry.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-registry-"));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, ".usrcp"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeRegistry(adapters: Partial<AdapterManifest>[]): void {
  fs.writeFileSync(
    path.join(tmpHome, ".usrcp", "adapters.json"),
    JSON.stringify({ adapters }, null, 2),
    { mode: 0o600 },
  );
}

describe("BUILTIN_ADAPTERS contract", () => {
  it("includes every in-tree adapter the codebase has historically shipped", () => {
    const values = BUILTIN_ADAPTERS.map((a) => a.value);
    // These are the adapters that landed across #54-60 plus the
    // builtin-internal trio. Listed here so adding/removing a
    // builtin requires an explicit test update.
    expect(values.sort()).toEqual(
      [
        "terminal",
        "openclaw",
        "mcp-agent",
        "discord",
        "telegram",
        "slack",
        "imessage",
        "obsidian",
        "linear",
        "google-calendar",
        "gmail",
        "github",
        "extension",
      ].sort(),
    );
  });

  it("flags exactly the encryption-aware adapters with requiresMasterKey + supportsRotateKey", () => {
    // The two flags should always agree on the in-tree adapters:
    // encrypting at setup AND honoring rotate-key are paired
    // commitments. (External adapters might violate this; the
    // contract allows it but warns operators in the README.)
    const requires = new Set(
      BUILTIN_ADAPTERS.filter((a) => a.requiresMasterKey).map((a) => a.value),
    );
    const rotates = new Set(
      BUILTIN_ADAPTERS.filter((a) => a.supportsRotateKey).map((a) => a.value),
    );
    expect(requires).toEqual(rotates);
    expect([...requires].sort()).toEqual(
      ["google-calendar", "gmail", "linear", "discord", "slack", "telegram", "github"].sort(),
    );
  });

  it("marks the three builtin-internal adapters", () => {
    const internal = BUILTIN_ADAPTERS.filter((a) => a.builtinInternal).map((a) => a.value);
    expect(internal.sort()).toEqual(["terminal", "openclaw", "mcp-agent"].sort());
  });

  it("marks iMessage as macOS-only and mcp-agent as hidden", () => {
    expect(findAdapter("imessage", [...BUILTIN_ADAPTERS])?.requiresMacOS).toBe(true);
    expect(findAdapter("mcp-agent", [...BUILTIN_ADAPTERS])?.hidden).toBe(true);
  });
});

describe("loadExternalAdapters (~/.usrcp/adapters.json)", () => {
  it("returns [] when the file is missing", () => {
    expect(loadExternalAdapters()).toEqual([]);
  });

  it("returns [] and warns when JSON is malformed (does not throw)", () => {
    fs.writeFileSync(path.join(tmpHome, ".usrcp", "adapters.json"), "{ not valid json");
    expect(() => loadExternalAdapters()).not.toThrow();
    expect(loadExternalAdapters()).toEqual([]);
  });

  it("returns the adapters array when shape is valid", () => {
    writeRegistry([
      {
        value: "notion",
        name: "Notion",
        blurb: "Pages and blocks you edited",
        setupFunction: "runNotionSetup",
        requiresMasterKey: true,
        supportsRotateKey: true,
        packageName: "usrcp-adapter-notion",
      },
    ]);
    const ext = loadExternalAdapters();
    expect(ext).toHaveLength(1);
    expect(ext[0].value).toBe("notion");
    expect(ext[0].packageName).toBe("usrcp-adapter-notion");
  });

  it("rejects entries missing required fields", () => {
    writeRegistry([
      // Missing 'value' - rejected.
      { name: "Bad", blurb: "..." } as Partial<AdapterManifest>,
      // Missing 'name' - rejected.
      { value: "x", blurb: "..." } as Partial<AdapterManifest>,
      // Good - accepted.
      { value: "good", name: "Good", blurb: "ok" },
    ]);
    const ext = loadExternalAdapters();
    expect(ext).toHaveLength(1);
    expect(ext[0].value).toBe("good");
  });

  it("rejects external adapters that claim builtinInternal", () => {
    writeRegistry([
      { value: "sneaky", name: "Sneaky", blurb: "...", builtinInternal: true } as Partial<AdapterManifest>,
    ]);
    const ext = loadExternalAdapters();
    expect(ext).toHaveLength(0);
  });
});

describe("getRegisteredAdapters (builtin + external)", () => {
  it("returns builtins only when no external file is present", () => {
    const all = getRegisteredAdapters();
    expect(all.length).toBe(BUILTIN_ADAPTERS.length);
  });

  it("appends external adapters after builtins", () => {
    writeRegistry([
      {
        value: "notion",
        name: "Notion",
        blurb: "...",
        setupFunction: "runNotionSetup",
        requiresMasterKey: true,
        supportsRotateKey: true,
      },
    ]);
    const all = getRegisteredAdapters();
    expect(all.length).toBe(BUILTIN_ADAPTERS.length + 1);
    expect(all[all.length - 1].value).toBe("notion");
  });

  it("dedupes by value with built-ins winning over external shadows", () => {
    // External tries to shadow the github built-in. The built-in
    // wins; the external entry is dropped (with a console warning).
    writeRegistry([
      {
        value: "github",
        name: "Hijacked GitHub",
        blurb: "should be ignored",
        setupFunction: "runEvilSetup",
      },
    ]);
    const all = getRegisteredAdapters();
    const github = findAdapter("github", all);
    expect(github).toBeTruthy();
    expect(github!.name).toBe("GitHub"); // built-in name, not "Hijacked GitHub"
    expect(github!.setupFunction).toBe("runGithubSetup"); // built-in setup, not evil
  });

  it("skipExternal=true bypasses the JSON read (test affordance)", () => {
    writeRegistry([{ value: "notion", name: "Notion", blurb: "..." }]);
    const all = getRegisteredAdapters({ skipExternal: true });
    expect(all.length).toBe(BUILTIN_ADAPTERS.length);
    expect(findAdapter("notion", all)).toBeUndefined();
  });
});

describe("derived helpers", () => {
  it("getMasterKeyRequiringAdapterValues includes external adapters that flag requiresMasterKey", () => {
    writeRegistry([
      {
        value: "notion",
        name: "Notion",
        blurb: "...",
        setupFunction: "runNotionSetup",
        requiresMasterKey: true,
      },
    ]);
    const masterKeySet = getMasterKeyRequiringAdapterValues();
    expect(masterKeySet.has("notion")).toBe(true);
    expect(masterKeySet.has("github")).toBe(true); // built-in still there
    expect(masterKeySet.has("terminal")).toBe(false); // no requiresMasterKey
  });

  it("getRotateKeyAdapterValues includes external adapters that flag supportsRotateKey", () => {
    writeRegistry([
      {
        value: "notion",
        name: "Notion",
        blurb: "...",
        setupFunction: "runNotionSetup",
        supportsRotateKey: true,
      },
    ]);
    const list = getRotateKeyAdapterValues();
    expect(list).toContain("notion");
    expect(list).toContain("github");
    expect(list).not.toContain("terminal");
  });
});

describe("resolveAdapterPackageName", () => {
  it("returns null for builtin-internal adapters", () => {
    const terminal = findAdapter("terminal", [...BUILTIN_ADAPTERS])!;
    expect(resolveAdapterPackageName(terminal)).toBeNull();
  });

  it("defaults to usrcp-<value> for in-tree adapters with no explicit packageName", () => {
    const discord = findAdapter("discord", [...BUILTIN_ADAPTERS])!;
    expect(resolveAdapterPackageName(discord)).toBe("usrcp-discord");
  });

  it("honors explicit packageName for external adapters", () => {
    const external: AdapterManifest = {
      value: "notion",
      name: "Notion",
      blurb: "...",
      setupFunction: "runNotionSetup",
      packageName: "usrcp-adapter-notion",
    };
    expect(resolveAdapterPackageName(external)).toBe("usrcp-adapter-notion");
  });
});
