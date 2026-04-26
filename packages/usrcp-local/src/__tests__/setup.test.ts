/**
 * Tests for the usrcp setup wizard (packages/usrcp-local/src/setup.ts).
 *
 * Strategy: we test the behavior that can be verified without a TTY:
 *   - The runSetup module exports a callable function.
 *   - Snowflake / chat-ID validation patterns.
 *   - Config write + load round-trips for both adapters (using the dist
 *     output via node-require, since setup.ts calls them through dynamic
 *     import of dist/ at runtime).
 *
 * Resume-from-failure is intentionally skipped in v0 (handoff stop condition).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-setup-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: load discord/telegram config modules from their dist output.
// We use the monorepo-relative path so no cross-package src imports are needed.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// From src/__tests__/ → go up to packages/
const packagesDir = path.resolve(__dirname, "../../../");

function discordConfigModule() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return require(path.join(packagesDir, "usrcp-discord/dist/config.js")) as any;
}

function telegramConfigModule() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return require(path.join(packagesDir, "usrcp-telegram/dist/config.js")) as any;
}

// ---------------------------------------------------------------------------
// Discord config write + read round-trip
// ---------------------------------------------------------------------------

describe("Discord adapter config (via dist)", () => {
  const GOOD_CONFIG = {
    discord_bot_token: "Bot.test.token.abc123",
    anthropic_api_key: "sk-ant-api03-test",
    allowlisted_channels: ["111111111111111111", "222222222222222222"],
    user_id: "333333333333333333",
  };

  it("writeDiscordConfig writes the file with mode 0600", () => {
    const m = discordConfigModule();
    m.writeDiscordConfig(GOOD_CONFIG);
    const p = m.getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writeDiscordConfig → loadConfig round-trips correctly", () => {
    const m = discordConfigModule();
    m.writeDiscordConfig(GOOD_CONFIG);
    const loaded = m.loadConfig();
    expect(loaded.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
    expect(loaded.allowlisted_channels).toEqual(GOOD_CONFIG.allowlisted_channels);
    expect(loaded.user_id).toBe(GOOD_CONFIG.user_id);
  });

  it("loadConfig exits if config file is missing", () => {
    const m = discordConfigModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => m.loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("loadConfig exits if allowlisted_channels is empty", () => {
    const m = discordConfigModule();
    const p = m.getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const bad = { ...GOOD_CONFIG, allowlisted_channels: [] };
    fs.writeFileSync(p, JSON.stringify(bad), { mode: 0o600 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => m.loadConfig()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("loadConfig exits if user_id is missing", () => {
    const m = discordConfigModule();
    const p = m.getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { user_id: _omit, ...partial } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(partial), { mode: 0o600 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => m.loadConfig()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Telegram config write + read round-trip
// ---------------------------------------------------------------------------

describe("Telegram adapter config (via dist)", () => {
  const GOOD_CONFIG = {
    telegram_bot_token: "123456:ABC-DEF-test",
    anthropic_api_key: "sk-ant-api03-test",
    allowlisted_chats: ["-100123456789", "987654321"],
    user_id: "12345678",
  };

  it("writeTelegramConfig writes the file with mode 0600", () => {
    const m = telegramConfigModule();
    m.writeTelegramConfig(GOOD_CONFIG);
    const p = m.getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writeTelegramConfig → loadConfig round-trips correctly", () => {
    const m = telegramConfigModule();
    m.writeTelegramConfig(GOOD_CONFIG);
    const loaded = m.loadConfig();
    expect(loaded.telegram_bot_token).toBe(GOOD_CONFIG.telegram_bot_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
    expect(loaded.allowlisted_chats).toEqual(GOOD_CONFIG.allowlisted_chats);
    expect(loaded.user_id).toBe(GOOD_CONFIG.user_id);
  });

  it("loadConfig exits if config file is missing", () => {
    const m = telegramConfigModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => m.loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("loadConfig exits if telegram_bot_token is missing", () => {
    const m = telegramConfigModule();
    const p = m.getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { telegram_bot_token: _omit, ...partial } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(partial), { mode: 0o600 });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => m.loadConfig()).toThrow("process.exit called");
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Snowflake / chat ID validation logic (inline — mirrors setup validation)
// ---------------------------------------------------------------------------

describe("ID validation patterns", () => {
  const SNOWFLAKE_RE = /^\d{17,20}$/;

  it("accepts valid 18-digit Discord snowflake", () => {
    expect(SNOWFLAKE_RE.test("111111111111111111")).toBe(true);
  });

  it("accepts valid 19-digit Discord snowflake", () => {
    expect(SNOWFLAKE_RE.test("1497475565521997887")).toBe(true);
  });

  it("rejects IDs shorter than 17 digits", () => {
    expect(SNOWFLAKE_RE.test("12345")).toBe(false);
  });

  it("rejects IDs longer than 20 digits", () => {
    expect(SNOWFLAKE_RE.test("123456789012345678901")).toBe(false);
  });

  it("rejects IDs with non-numeric characters", () => {
    expect(SNOWFLAKE_RE.test("abc123456789012345")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(SNOWFLAKE_RE.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSetup export shape
// ---------------------------------------------------------------------------

describe("runSetup export", () => {
  it("exports a callable runSetup function", async () => {
    const mod = await import("../setup.js");
    expect(typeof mod.runSetup).toBe("function");
  });
});
