import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getClientConfigPath, type SupportedClient } from "../index.js";

let origHome: string | undefined;
let origAppdata: string | undefined;
let origXdg: string | undefined;
let tmpHome: string;

beforeEach(() => {
  origHome = process.env.HOME;
  origAppdata = process.env.APPDATA;
  origXdg = process.env.XDG_CONFIG_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-client-test-"));
  process.env.HOME = tmpHome;
  delete process.env.APPDATA;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origAppdata !== undefined) process.env.APPDATA = origAppdata;
  else delete process.env.APPDATA;
  if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
  else delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("getClientConfigPath", () => {
  it("claude maps to a per-platform claude_desktop_config.json", () => {
    const p = getClientConfigPath("claude");
    expect(p.endsWith("claude_desktop_config.json")).toBe(true);
    expect(p.startsWith(tmpHome)).toBe(true);
  });

  it("cursor maps to ~/.cursor/mcp.json", () => {
    const p = getClientConfigPath("cursor");
    expect(p).toBe(path.join(tmpHome, ".cursor", "mcp.json"));
  });

  it("continue maps to ~/.continue/config.json", () => {
    const p = getClientConfigPath("continue");
    expect(p).toBe(path.join(tmpHome, ".continue", "config.json"));
  });

  it("cline maps to cline_mcp_settings.json under VS Code user globalStorage", () => {
    const p = getClientConfigPath("cline");
    expect(p.endsWith("cline_mcp_settings.json")).toBe(true);
    expect(p).toContain("saoudrizwan.claude-dev");
  });

  it("returns distinct paths for each client", () => {
    const seen = new Set<string>();
    for (const c of ["claude", "cursor", "continue", "cline"] as SupportedClient[]) {
      const p = getClientConfigPath(c);
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });
});
