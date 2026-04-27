/**
 * Tests for config I/O.
 *
 * Coverage:
 *   - getConfigPath() points under HOME/.usrcp
 *   - writeObsidianConfig writes mode 0600
 *   - readPartialConfig returns {} when file is missing or malformed
 *   - loadConfig exits on missing file / missing fields / non-existent vault
 *   - loadConfig round-trips a valid config
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeObsidianConfig,
  readPartialConfig,
  loadConfig,
  type ObsidianConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
let vaultDir: string;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-obsidian-config-"));
  process.env.HOME = tmpHome;
  // A real vault directory the config can point at.
  vaultDir = path.join(tmpHome, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function goodConfig(): ObsidianConfig {
  return {
    vault_path: vaultDir,
    domain: "obsidian",
    debounce_ms: 1500,
  };
}

// ---------------------------------------------------------------------------
// getConfigPath
// ---------------------------------------------------------------------------

describe("getConfigPath", () => {
  it("points to HOME/.usrcp/obsidian-config.json", () => {
    const p = getConfigPath();
    expect(p).toBe(path.join(tmpHome, ".usrcp", "obsidian-config.json"));
  });
});

// ---------------------------------------------------------------------------
// writeObsidianConfig
// ---------------------------------------------------------------------------

describe("writeObsidianConfig", () => {
  it("creates parent directory and writes file at mode 0600", () => {
    writeObsidianConfig(goodConfig());
    const p = getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("re-chmods existing file to 0600 even if originally permissive", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}", { mode: 0o644 });
    writeObsidianConfig(goodConfig());
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("overwrites prior content (truncates)", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x".repeat(10000));
    writeObsidianConfig(goodConfig());
    const body = fs.readFileSync(p, "utf8");
    // No leftover x's from the prior 10kB write.
    expect(body).not.toContain("xxxxxxxxxx");
    expect(JSON.parse(body)).toMatchObject({ domain: "obsidian" });
  });
});

// ---------------------------------------------------------------------------
// readPartialConfig
// ---------------------------------------------------------------------------

describe("readPartialConfig", () => {
  it("returns {} when the file does not exist", () => {
    expect(readPartialConfig()).toEqual({});
  });

  it("returns {} when the file is malformed JSON", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not-json{{{");
    expect(readPartialConfig()).toEqual({});
  });

  it("returns the parsed contents when the file exists and is valid", () => {
    writeObsidianConfig(goodConfig());
    const partial = readPartialConfig();
    expect(partial.vault_path).toBe(vaultDir);
    expect(partial.domain).toBe("obsidian");
    expect(partial.debounce_ms).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// loadConfig (exit-on-error semantics)
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("exits with code 1 when the config file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when the file is malformed JSON", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not-json{{{");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when vault_path is missing", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { vault_path: _omit, ...partial } = goodConfig();
    fs.writeFileSync(p, JSON.stringify(partial), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when debounce_ms is not a number", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ ...goodConfig(), debounce_ms: "1500" }),
      { mode: 0o600 },
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with code 1 when vault_path does not exist on disk", () => {
    writeObsidianConfig({ ...goodConfig(), vault_path: "/this/path/does/not/exist/anywhere" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("loads a valid config successfully", () => {
    writeObsidianConfig(goodConfig());
    const loaded = loadConfig();
    expect(loaded.vault_path).toBe(vaultDir);
    expect(loaded.domain).toBe("obsidian");
    expect(loaded.debounce_ms).toBe(1500);
  });

  it("preserves optional filter fields on round-trip", () => {
    writeObsidianConfig({
      ...goodConfig(),
      allowed_subdirs: ["journal", "work"],
      excluded_subdirs: ["private"],
      allowed_tags: ["public"],
      excluded_tags: ["secret"],
    });
    const loaded = loadConfig();
    expect(loaded.allowed_subdirs).toEqual(["journal", "work"]);
    expect(loaded.excluded_subdirs).toEqual(["private"]);
    expect(loaded.allowed_tags).toEqual(["public"]);
    expect(loaded.excluded_tags).toEqual(["secret"]);
  });
});
