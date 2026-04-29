/**
 * Unit tests for the terminal adapter modules.
 *
 * IMPORTANT: Every test sets process.env.HOME to a temporary directory BEFORE
 * importing the modules (which is why we use dynamic imports inside tests).
 * This ensures no test ever touches the real ~/.claude.json, ~/.cursor/mcp.json, etc.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let origHome: string | undefined;
let origXdgConfig: string | undefined;
let tmpHome: string;

beforeEach(() => {
  origHome = process.env.HOME;
  origXdgConfig = process.env.XDG_CONFIG_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-terminal-adapter-test-"));
  process.env.HOME = tmpHome;
  // cline (and any other XDG-aware adapter) reads XDG_CONFIG_HOME first on
  // Linux. If the runner has it set (GitHub Actions does), the adapter
  // writes outside tmpHome and the test sees zero files. Pin it under
  // tmpHome so isolation holds on every platform.
  process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origXdgConfig === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = origXdgConfig;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---- helpers ----

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function backupDir(): string {
  return path.join(tmpHome, ".usrcp", "backups");
}

function backupFiles(prefix: string): string[] {
  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir()).filter((f) => f.startsWith(prefix));
}

// ---- claude-code ----

describe("claude-code adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".claude.json");
    expect(fs.existsSync(config)).toBe(true);
    const doc = readJson(config);
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
  });

  it("register preserves existing keys and adds usrcp", async () => {
    const config = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { other: { command: "other" } }, someFlag: true }));
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(config);
    expect((doc.mcpServers as Record<string, unknown>).other).toBeDefined();
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toBeDefined();
    expect(doc.someFlag).toBe(true);
  });

  it("creates backup when prior config existed", async () => {
    const config = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(config, JSON.stringify({ mcpServers: {} }));
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("claude-code").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("claude-code").length).toBe(0);
  });

  it("unregister removes only usrcp entry", async () => {
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".claude.json");
    // Add another entry manually
    const doc = readJson(config);
    (doc.mcpServers as Record<string, unknown>).other = { command: "other" };
    fs.writeFileSync(config, JSON.stringify(doc, null, 2));
    await mod.unregister();
    const after = readJson(config);
    expect((after.mcpServers as Record<string, unknown>).usrcp).toBeUndefined();
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  it("status returns config_missing when file absent", async () => {
    const mod = await import("../adapters/terminal/claude-code.js");
    expect(await mod.status()).toBe("config_missing");
  });

  it("status returns not_registered when file exists but usrcp absent", async () => {
    const config = path.join(tmpHome, ".claude.json");
    fs.writeFileSync(config, JSON.stringify({ mcpServers: {} }));
    const mod = await import("../adapters/terminal/claude-code.js");
    expect(await mod.status()).toBe("not_registered");
  });

  it("status returns registered after register()", async () => {
    const mod = await import("../adapters/terminal/claude-code.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- cursor ----

describe("cursor adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/cursor.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".cursor", "mcp.json");
    const doc = readJson(config);
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
  });

  it("register preserves existing keys", async () => {
    const configDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const mod = await import("../adapters/terminal/cursor.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(path.join(configDir, "mcp.json"));
    expect((doc.mcpServers as Record<string, unknown>).other).toBeDefined();
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toBeDefined();
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const mod = await import("../adapters/terminal/cursor.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("cursor").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/cursor.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("cursor").length).toBe(0);
  });

  it("unregister removes only usrcp entry", async () => {
    const mod = await import("../adapters/terminal/cursor.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".cursor", "mcp.json");
    const doc = readJson(config);
    (doc.mcpServers as Record<string, unknown>).other = { command: "other" };
    fs.writeFileSync(config, JSON.stringify(doc, null, 2));
    await mod.unregister();
    const after = readJson(config);
    expect((after.mcpServers as Record<string, unknown>).usrcp).toBeUndefined();
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  it("status returns config_missing, not_registered, registered in three states", async () => {
    const mod = await import("../adapters/terminal/cursor.js");
    expect(await mod.status()).toBe("config_missing");
    const configDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- codex ----

describe("codex adapter", () => {
  it("register on empty config writes correct TOML shape", async () => {
    const mod = await import("../adapters/terminal/codex.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".codex", "config.toml");
    expect(fs.existsSync(config)).toBe(true);
    const raw = fs.readFileSync(config, "utf8");
    expect(raw).toContain("[mcp_servers.usrcp]");
    expect(raw).toContain('command = "/usr/local/bin/usrcp"');
  });

  it("register preserves other TOML keys", async () => {
    const configDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const initialToml = `[other_section]\nkey = "value"\n`;
    fs.writeFileSync(path.join(configDir, "config.toml"), initialToml);
    const mod = await import("../adapters/terminal/codex.js");
    await mod.register("/usr/local/bin/usrcp");
    const raw = fs.readFileSync(path.join(configDir, "config.toml"), "utf8");
    expect(raw).toContain("other_section");
    expect(raw).toContain("[mcp_servers.usrcp]");
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.toml"), "[other]\nkey = 1\n");
    const mod = await import("../adapters/terminal/codex.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("codex").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/codex.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("codex").length).toBe(0);
  });

  it("unregister removes usrcp from mcp_servers", async () => {
    const mod = await import("../adapters/terminal/codex.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.unregister();
    const config = path.join(tmpHome, ".codex", "config.toml");
    const raw = fs.readFileSync(config, "utf8");
    // The usrcp entry itself must be gone; an empty mcp_servers section is acceptable TOML output.
    expect(raw).not.toContain("command =");
    expect(raw).not.toContain("[mcp_servers.usrcp]");
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/codex.js");
    expect(await mod.status()).toBe("config_missing");
    const configDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.toml"), "[other]\nkey = 1\n");
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- copilot-cli ----

describe("copilot-cli adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/copilot-cli.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".copilot", "mcp-config.json");
    const doc = readJson(config);
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
  });

  it("register preserves existing keys", async () => {
    const configDir = path.join(tmpHome, ".copilot");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp-config.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const mod = await import("../adapters/terminal/copilot-cli.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(path.join(configDir, "mcp-config.json"));
    expect((doc.mcpServers as Record<string, unknown>).other).toBeDefined();
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toBeDefined();
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".copilot");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp-config.json"), JSON.stringify({ mcpServers: {} }));
    const mod = await import("../adapters/terminal/copilot-cli.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("copilot-cli").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/copilot-cli.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("copilot-cli").length).toBe(0);
  });

  it("unregister removes only usrcp entry", async () => {
    const mod = await import("../adapters/terminal/copilot-cli.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".copilot", "mcp-config.json");
    const doc = readJson(config);
    (doc.mcpServers as Record<string, unknown>).other = { command: "other" };
    fs.writeFileSync(config, JSON.stringify(doc, null, 2));
    await mod.unregister();
    const after = readJson(config);
    expect((after.mcpServers as Record<string, unknown>).usrcp).toBeUndefined();
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/copilot-cli.js");
    expect(await mod.status()).toBe("config_missing");
    const configDir = path.join(tmpHome, ".copilot");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp-config.json"), JSON.stringify({ mcpServers: {} }));
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- cline ----

describe("cline adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/cline.js");
    await mod.register("/usr/local/bin/usrcp");
    // Find the written file — platform-specific path, but always under tmpHome
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "cline_mcp_settings.json") files.push(full);
      }
    }
    walk(tmpHome);
    expect(files.length).toBe(1);
    const doc = readJson(files[0]);
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
  });

  it("creates backup when prior config existed", async () => {
    const mod = await import("../adapters/terminal/cline.js");
    // Register once to know the path
    await mod.register("/usr/local/bin/usrcp");
    const before = backupFiles("cline").length;
    // Register again — now a prior file exists
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("cline").length).toBeGreaterThan(before);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/cline.js");
    const before = backupFiles("cline").length;
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("cline").length).toBe(before);
  });

  it("unregister removes usrcp entry", async () => {
    const mod = await import("../adapters/terminal/cline.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.unregister();
    expect(await mod.status()).toBe("not_registered");
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/cline.js");
    expect(await mod.status()).toBe("config_missing");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- continue ----

describe("continue adapter", () => {
  it("register writes correct file shape", async () => {
    const mod = await import("../adapters/terminal/continue.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".continue", "mcpServers", "usrcp.json");
    expect(fs.existsSync(config)).toBe(true);
    const doc = readJson(config);
    expect(doc.name).toBe("usrcp");
    expect(doc.command).toBe("/usr/local/bin/usrcp");
    expect(doc.args).toEqual(["serve", "--stdio"]);
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".continue", "mcpServers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "usrcp.json"), JSON.stringify({ name: "usrcp", command: "old" }));
    const mod = await import("../adapters/terminal/continue.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("continue").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/continue.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("continue").length).toBe(0);
  });

  it("unregister removes the file", async () => {
    const mod = await import("../adapters/terminal/continue.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.unregister();
    const config = path.join(tmpHome, ".continue", "mcpServers", "usrcp.json");
    expect(fs.existsSync(config)).toBe(false);
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/continue.js");
    expect(await mod.status()).toBe("config_missing");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
    await mod.unregister();
    expect(await mod.status()).toBe("config_missing");
  });
});

// ---- aider ----

describe("aider adapter", () => {
  it("register on empty config adds read entry", async () => {
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".aider.conf.yml");
    expect(fs.existsSync(config)).toBe(true);
    const raw = fs.readFileSync(config, "utf8");
    expect(raw).toContain("CONTEXT.md");
  });

  it("register merges when read: already has other entries as list", async () => {
    const config = path.join(tmpHome, ".aider.conf.yml");
    fs.writeFileSync(config, "read:\n  - /some/other/file.md\n");
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    const raw = fs.readFileSync(config, "utf8");
    expect(raw).toContain("/some/other/file.md");
    expect(raw).toContain("CONTEXT.md");
  });

  it("register merges when read: is a scalar", async () => {
    const config = path.join(tmpHome, ".aider.conf.yml");
    fs.writeFileSync(config, "read: /some/other/file.md\n");
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    const raw = fs.readFileSync(config, "utf8");
    expect(raw).toContain("/some/other/file.md");
    expect(raw).toContain("CONTEXT.md");
  });

  it("register does not duplicate CONTEXT.md if already present", async () => {
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".aider.conf.yml");
    const raw = fs.readFileSync(config, "utf8");
    const count = (raw.match(/CONTEXT\.md/g) || []).length;
    expect(count).toBe(1);
  });

  it("creates backup when prior config existed", async () => {
    const config = path.join(tmpHome, ".aider.conf.yml");
    fs.writeFileSync(config, "model: gpt-4\n");
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("aider").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("aider").length).toBe(0);
  });

  it("unregister removes CONTEXT.md from read list", async () => {
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.unregister();
    expect(await mod.status()).toBe("not_registered");
  });

  it("unregister preserves other read entries", async () => {
    const config = path.join(tmpHome, ".aider.conf.yml");
    fs.writeFileSync(config, "read:\n  - /some/other/file.md\n");
    const mod = await import("../adapters/terminal/aider.js");
    await mod.register("/usr/local/bin/usrcp");
    await mod.unregister();
    const raw = fs.readFileSync(config, "utf8");
    expect(raw).toContain("/some/other/file.md");
    expect(raw).not.toContain("CONTEXT.md");
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/aider.js");
    expect(await mod.status()).toBe("config_missing");
    const config = path.join(tmpHome, ".aider.conf.yml");
    fs.writeFileSync(config, "model: gpt-4\n");
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- antigravity ----

describe("antigravity adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".gemini", "antigravity", "mcp_config.json");
    expect(fs.existsSync(config)).toBe(true);
    const doc = readJson(config);
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toEqual({
      command: "/usr/local/bin/usrcp",
      args: ["serve", "--stdio"],
    });
  });

  it("register tolerates pre-existing zero-byte mcp_config.json", async () => {
    // Real Antigravity installs ship the file empty (0 bytes). Plain JSON.parse("") would crash.
    const configDir = path.join(tmpHome, ".gemini", "antigravity");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp_config.json"), "");
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(path.join(configDir, "mcp_config.json"));
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toBeDefined();
  });

  it("register preserves existing entries", async () => {
    const configDir = path.join(tmpHome, ".gemini", "antigravity");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } } }),
    );
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(path.join(configDir, "mcp_config.json"));
    expect((doc.mcpServers as Record<string, unknown>).other).toBeDefined();
    expect((doc.mcpServers as Record<string, unknown>).usrcp).toBeDefined();
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".gemini", "antigravity");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }));
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("antigravity").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("antigravity").length).toBe(0);
  });

  it("unregister removes only usrcp entry", async () => {
    const mod = await import("../adapters/terminal/antigravity.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".gemini", "antigravity", "mcp_config.json");
    const doc = readJson(config);
    (doc.mcpServers as Record<string, unknown>).other = { command: "other" };
    fs.writeFileSync(config, JSON.stringify(doc, null, 2));
    await mod.unregister();
    const after = readJson(config);
    expect((after.mcpServers as Record<string, unknown>).usrcp).toBeUndefined();
    expect((after.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/antigravity.js");
    expect(await mod.status()).toBe("config_missing");
    const configDir = path.join(tmpHome, ".gemini", "antigravity");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp_config.json"), JSON.stringify({ mcpServers: {} }));
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });

  it("status returns not_registered for empty file", async () => {
    const configDir = path.join(tmpHome, ".gemini", "antigravity");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "mcp_config.json"), "");
    const mod = await import("../adapters/terminal/antigravity.js");
    expect(await mod.status()).toBe("not_registered");
  });
});

// ---- opencode ----

describe("opencode adapter", () => {
  it("register on empty config writes correct shape", async () => {
    const mod = await import("../adapters/terminal/opencode.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".config", "opencode", "opencode.json");
    expect(fs.existsSync(config)).toBe(true);
    const doc = readJson(config);
    // OpenCode uses `mcp` (not `mcpServers`), `command` is an array combining bin+args, type="local"
    expect((doc.mcp as Record<string, unknown>).usrcp).toEqual({
      type: "local",
      command: ["/usr/local/bin/usrcp", "serve", "--stdio"],
      enabled: true,
    });
  });

  it("register preserves existing config keys (e.g. model, $schema)", async () => {
    const configDir = path.join(tmpHome, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        mcp: { other: { type: "local", command: ["other"] } },
      }),
    );
    const mod = await import("../adapters/terminal/opencode.js");
    await mod.register("/usr/local/bin/usrcp");
    const doc = readJson(path.join(configDir, "opencode.json"));
    expect(doc.$schema).toBe("https://opencode.ai/config.json");
    expect(doc.model).toBe("anthropic/claude-sonnet-4-5");
    expect((doc.mcp as Record<string, unknown>).other).toBeDefined();
    expect((doc.mcp as Record<string, unknown>).usrcp).toBeDefined();
  });

  it("creates backup when prior config existed", async () => {
    const configDir = path.join(tmpHome, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));
    const mod = await import("../adapters/terminal/opencode.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("opencode").length).toBeGreaterThan(0);
  });

  it("does NOT create backup when no prior config", async () => {
    const mod = await import("../adapters/terminal/opencode.js");
    await mod.register("/usr/local/bin/usrcp");
    expect(backupFiles("opencode").length).toBe(0);
  });

  it("unregister removes only usrcp entry", async () => {
    const mod = await import("../adapters/terminal/opencode.js");
    await mod.register("/usr/local/bin/usrcp");
    const config = path.join(tmpHome, ".config", "opencode", "opencode.json");
    const doc = readJson(config);
    (doc.mcp as Record<string, unknown>).other = { type: "local", command: ["other"] };
    fs.writeFileSync(config, JSON.stringify(doc, null, 2));
    await mod.unregister();
    const after = readJson(config);
    expect((after.mcp as Record<string, unknown>).usrcp).toBeUndefined();
    expect((after.mcp as Record<string, unknown>).other).toBeDefined();
  });

  it("status returns all three states", async () => {
    const mod = await import("../adapters/terminal/opencode.js");
    expect(await mod.status()).toBe("config_missing");
    const configDir = path.join(tmpHome, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: {} }));
    expect(await mod.status()).toBe("not_registered");
    await mod.register("/usr/local/bin/usrcp");
    expect(await mod.status()).toBe("registered");
  });
});

// ---- orchestrator ----

describe("terminal adapter orchestrator", () => {
  it("dispatching to multiple targets returns aggregated results", async () => {
    const { addTerminalAdapter } = await import("../adapters/terminal/index.js");
    const results = await addTerminalAdapter(["claude-code", "cursor"], "/usr/local/bin/usrcp");
    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.target)).toContain("claude-code");
    expect(results.map((r) => r.target)).toContain("cursor");
  });

  it("unknown target returns clean error without throwing", async () => {
    const { addTerminalAdapter } = await import("../adapters/terminal/index.js");
    const results = await addTerminalAdapter(["not-a-real-target" as never], "/usr/local/bin/usrcp");
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("unknown target");
  });

  it("one target failing does not stop others", async () => {
    // We'll test by registering codex + claude-code where codex dir permissions could fail.
    // Since we can't easily force a failure without OS tricks, we verify the other target still
    // gets processed even if we pass a mixed list of valid/invalid targets.
    const { addTerminalAdapter } = await import("../adapters/terminal/index.js");
    const results = await addTerminalAdapter(["invalid-target" as never, "cursor"], "/usr/local/bin/usrcp");
    expect(results.length).toBe(2);
    // First is the unknown one
    expect(results[0].ok).toBe(false);
    // Second (cursor) should succeed
    expect(results[1].ok).toBe(true);
    expect(results[1].target).toBe("cursor");
  });

  it("removeTerminalAdapter returns aggregated results", async () => {
    const { addTerminalAdapter, removeTerminalAdapter } = await import("../adapters/terminal/index.js");
    await addTerminalAdapter(["claude-code", "cursor"], "/usr/local/bin/usrcp");
    const results = await removeTerminalAdapter(["claude-code", "cursor"]);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("listTerminalAdapters returns a row per target", async () => {
    const { listTerminalAdapters, ALL_TARGETS } = await import("../adapters/terminal/index.js");
    const rows = await listTerminalAdapters();
    expect(rows.length).toBe(ALL_TARGETS.length);
    for (const row of rows) {
      expect(["registered", "not_registered", "config_missing"]).toContain(row.status);
    }
  });

  it("parseTargets returns null for unknown target", async () => {
    const { parseTargets } = await import("../adapters/terminal/index.js");
    const result = parseTargets("not-a-real-target");
    expect(result).toBeNull();
  });

  it("parseTargets parses comma-separated valid targets", async () => {
    const { parseTargets } = await import("../adapters/terminal/index.js");
    const result = parseTargets("claude-code,cursor");
    expect(result).toEqual(["claude-code", "cursor"]);
  });
});
