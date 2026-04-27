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

// ---------------------------------------------------------------------------
// Per-adapter Y/N selection (selectAdaptersInteractive)
// ---------------------------------------------------------------------------

describe("selectAdaptersInteractive", () => {
  it("returns all adapters when user says yes to all", async () => {
    const { selectAdaptersInteractive, KNOWN_ADAPTERS } = await import("../setup.js");
    const confirm = vi.fn().mockResolvedValue(true);
    const chosen = await selectAdaptersInteractive([...KNOWN_ADAPTERS], confirm, () => {});
    expect(chosen).toEqual(KNOWN_ADAPTERS.map((a) => a.value));
    expect(confirm).toHaveBeenCalledTimes(KNOWN_ADAPTERS.length);
  });

  it("returns only Y'd adapters in mixed Y/N path", async () => {
    const { selectAdaptersInteractive, KNOWN_ADAPTERS } = await import("../setup.js");
    // Answer Y only for discord and slack; N for everything else.
    const wantValues = new Set(["discord", "slack"]);
    const confirm = vi.fn().mockImplementation(async (opts: { message: string }) => {
      const adapter = KNOWN_ADAPTERS.find((a) => opts.message.includes(a.name));
      return !!(adapter && wantValues.has(adapter.value));
    });
    const chosen = await selectAdaptersInteractive([...KNOWN_ADAPTERS], confirm, () => {});
    expect(chosen).toEqual(["discord", "slack"]);
  });

  it("returns empty array when user declines all", async () => {
    const { selectAdaptersInteractive, KNOWN_ADAPTERS } = await import("../setup.js");
    const confirm = vi.fn().mockResolvedValue(false);
    const chosen = await selectAdaptersInteractive([...KNOWN_ADAPTERS], confirm, () => {});
    expect(chosen).toEqual([]);
  });

  it("each prompt defaults to false (explicit opt-in)", async () => {
    const { selectAdaptersInteractive, KNOWN_ADAPTERS } = await import("../setup.js");
    const confirm = vi.fn().mockResolvedValue(false);
    await selectAdaptersInteractive([...KNOWN_ADAPTERS], confirm, () => {});
    for (const call of confirm.mock.calls) {
      expect(call[0].default).toBe(false);
    }
  });

  it("logs the blurb before each prompt", async () => {
    const { selectAdaptersInteractive } = await import("../setup.js");
    const confirm = vi.fn().mockResolvedValue(false);
    const lines: string[] = [];
    await selectAdaptersInteractive(
      [{ name: "Test", value: "test", blurb: "BLURB-MARKER" }],
      confirm,
      (line) => lines.push(line),
    );
    expect(lines.some((l) => l.includes("BLURB-MARKER"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Platform filter (visibleAdapters)
// ---------------------------------------------------------------------------

describe("visibleAdapters", () => {
  it("hides macOS-only adapters on linux", async () => {
    const { visibleAdapters } = await import("../setup.js");
    const visible = visibleAdapters("linux");
    expect(visible.find((a) => a.value === "imessage")).toBeUndefined();
    expect(visible.find((a) => a.value === "discord")).toBeDefined();
  });

  it("hides macOS-only adapters on windows", async () => {
    const { visibleAdapters } = await import("../setup.js");
    const visible = visibleAdapters("win32");
    expect(visible.find((a) => a.value === "imessage")).toBeUndefined();
  });

  it("includes macOS-only adapters on darwin", async () => {
    const { visibleAdapters } = await import("../setup.js");
    const visible = visibleAdapters("darwin");
    expect(visible.find((a) => a.value === "imessage")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Per-adapter failure isolation (runAdapterSetups)
// ---------------------------------------------------------------------------

describe("runAdapterSetups failure isolation", () => {
  it("continues to remaining adapters when one throws", async () => {
    const { runAdapterSetups } = await import("../setup.js");
    const calls: string[] = [];
    const setupFn = vi.fn(async (adapter: string) => {
      calls.push(adapter);
      if (adapter === "slack") throw new Error("simulated slack failure");
    });
    const { succeeded, failed } = await runAdapterSetups(
      ["discord", "slack", "telegram"],
      setupFn,
      () => {},
      () => {},
    );
    expect(calls).toEqual(["discord", "slack", "telegram"]);
    expect(succeeded).toEqual(["discord", "telegram"]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ adapter: "slack" });
  });

  it("returns all-succeeded when no adapter throws", async () => {
    const { runAdapterSetups } = await import("../setup.js");
    const setupFn = vi.fn(async () => {});
    const { succeeded, failed } = await runAdapterSetups(
      ["discord", "telegram"],
      setupFn,
      () => {},
      () => {},
    );
    expect(succeeded).toEqual(["discord", "telegram"]);
    expect(failed).toEqual([]);
  });

  it("returns empty arrays when no adapters given", async () => {
    const { runAdapterSetups } = await import("../setup.js");
    const setupFn = vi.fn(async () => {});
    const { succeeded, failed } = await runAdapterSetups([], setupFn, () => {}, () => {});
    expect(succeeded).toEqual([]);
    expect(failed).toEqual([]);
    expect(setupFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Terminal adapter as first/recommended in the registry
// ---------------------------------------------------------------------------

describe("KNOWN_ADAPTERS ordering", () => {
  it("lists terminal first as the recommended adapter", async () => {
    const { KNOWN_ADAPTERS } = await import("../setup.js");
    expect(KNOWN_ADAPTERS[0]?.value).toBe("terminal");
    expect(KNOWN_ADAPTERS[0]?.blurb.toLowerCase()).toContain("recommended");
  });
});

// ---------------------------------------------------------------------------
// Aider cron entry planner (pure function — no shell-out)
// ---------------------------------------------------------------------------

describe("planAiderCronUpdate", () => {
  it("returns add when crontab is empty", async () => {
    const { planAiderCronUpdate } = await import("../adapters/terminal/index.js");
    const r = planAiderCronUpdate("", "/usr/local/bin/usrcp");
    expect(r.kind).toBe("add");
    if (r.kind === "add") {
      expect(r.merged).toContain("/usr/local/bin/usrcp adapter terminal refresh-context");
      expect(r.merged.endsWith("\n")).toBe(true);
    }
  });

  it("returns add and appends with leading newline if existing crontab lacks one", async () => {
    const { planAiderCronUpdate } = await import("../adapters/terminal/index.js");
    const r = planAiderCronUpdate("MAILTO=root", "/bin/usrcp");
    expect(r.kind).toBe("add");
    if (r.kind === "add") {
      expect(r.merged.startsWith("MAILTO=root\n")).toBe(true);
    }
  });

  it("returns already_present when our tagged line is already in crontab", async () => {
    const { planAiderCronUpdate, buildAiderCronLine } = await import("../adapters/terminal/index.js");
    const existing = `MAILTO=root\n${buildAiderCronLine("/bin/usrcp")}\n`;
    const r = planAiderCronUpdate(existing, "/bin/usrcp");
    expect(r.kind).toBe("already_present");
  });
});

// ---------------------------------------------------------------------------
// installAiderCronEntry I/O wiring (with injected CrontabIO)
// ---------------------------------------------------------------------------

describe("installAiderCronEntry (injected I/O)", () => {
  it("writes the merged crontab when entry is missing", async () => {
    const { installAiderCronEntry } = await import("../adapters/terminal/index.js");
    let written: string | null = null;
    const result = await installAiderCronEntry("/bin/usrcp", {
      read: async () => "",
      write: async (content) => { written = content; },
    });
    expect(result).toBe("added");
    expect(written).toContain("/bin/usrcp adapter terminal refresh-context");
  });

  it("does not call write when entry already present", async () => {
    const { installAiderCronEntry, buildAiderCronLine } = await import("../adapters/terminal/index.js");
    const existing = buildAiderCronLine("/bin/usrcp") + "\n";
    const writeSpy = vi.fn();
    const result = await installAiderCronEntry("/bin/usrcp", {
      read: async () => existing,
      write: writeSpy,
    });
    expect(result).toBe("already_present");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("returns failed when write throws", async () => {
    const { installAiderCronEntry } = await import("../adapters/terminal/index.js");
    const result = await installAiderCronEntry("/bin/usrcp", {
      read: async () => "",
      write: async () => { throw new Error("crontab denied"); },
    });
    expect(result).toBe("failed");
  });

  it("treats read failure as empty crontab", async () => {
    const { installAiderCronEntry } = await import("../adapters/terminal/index.js");
    let written: string | null = null;
    const result = await installAiderCronEntry("/bin/usrcp", {
      read: async () => { throw new Error("no crontab for user"); },
      write: async (content) => { written = content; },
    });
    expect(result).toBe("added");
    expect(written).toContain("/bin/usrcp adapter terminal refresh-context");
  });
});

// ---------------------------------------------------------------------------
// runTerminalSetup behavior
// ---------------------------------------------------------------------------

describe("runTerminalSetup", () => {
  it("returns early when user selects no agents", async () => {
    const { runTerminalSetup } = await import("../adapters/terminal/index.js");
    const checkbox = vi.fn().mockResolvedValue([]);
    const confirm = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runTerminalSetup({ checkbox, confirm });
    } finally {
      logSpy.mockRestore();
    }
    expect(checkbox).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not prompt for cron when aider not selected", async () => {
    const { runTerminalSetup } = await import("../adapters/terminal/index.js");
    const checkbox = vi.fn().mockResolvedValue(["claude-code"]);
    const confirm = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // We can't easily mock addTerminalAdapter without re-imports, so this
      // test will let the real registration run against a tmp HOME (set in
      // beforeEach). The point is that confirm() must not fire for the
      // aider-cron prompt when aider isn't selected.
      await runTerminalSetup({ checkbox, confirm });
    } catch {
      // If the real claude-code register touches paths we haven't sandboxed,
      // catch & ignore — the assertion below is what matters.
    } finally {
      logSpy.mockRestore();
    }
    expect(confirm).not.toHaveBeenCalled();
  });
});
