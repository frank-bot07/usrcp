import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeLinearConfig,
  readPartialConfig,
  loadConfig,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type LinearConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-linear-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: LinearConfig = {
  linear_api_key: "lin_api_test_key_xxx",
  allowlisted_team_ids: ["team-aaa", "team-bbb"],
  poll_interval_s: 60,
  domain: "linear",
};

// ---------------------------------------------------------------------------
// getConfigPath
// ---------------------------------------------------------------------------

describe("getConfigPath", () => {
  it("points to HOME/.usrcp/linear-config.json", () => {
    expect(getConfigPath()).toBe(path.join(tmpHome, ".usrcp", "linear-config.json"));
  });
});

// ---------------------------------------------------------------------------
// writeLinearConfig
// ---------------------------------------------------------------------------

describe("writeLinearConfig", () => {
  it("creates parent dir and writes file at mode 0600", () => {
    writeLinearConfig(GOOD_CONFIG);
    const p = getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("re-chmods existing file from 0644 → 0600", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}", { mode: 0o644 });
    writeLinearConfig(GOOD_CONFIG);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("round-trips a valid config", () => {
    writeLinearConfig(GOOD_CONFIG);
    const loaded = loadConfig();
    expect(loaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(loaded.allowlisted_team_ids).toEqual(GOOD_CONFIG.allowlisted_team_ids);
    expect(loaded.poll_interval_s).toBe(60);
    expect(loaded.domain).toBe("linear");
  });
});

// ---------------------------------------------------------------------------
// readPartialConfig
// ---------------------------------------------------------------------------

describe("readPartialConfig", () => {
  it("returns {} when file is missing", () => {
    expect(readPartialConfig()).toEqual({});
  });

  it("returns {} when file is malformed JSON", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json{{{");
    expect(readPartialConfig()).toEqual({});
  });

  it("returns parsed contents on a well-formed file", () => {
    writeLinearConfig({ ...GOOD_CONFIG, last_synced_at: "2026-04-27T00:00:00.000Z" });
    const partial = readPartialConfig();
    expect(partial.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(partial.last_synced_at).toBe("2026-04-27T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("exits 1 when config file is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when config is malformed JSON", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json{{{");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when allowlisted_team_ids is empty", () => {
    writeLinearConfig({ ...GOOD_CONFIG, allowlisted_team_ids: [] });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when linear_api_key is missing", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { linear_api_key: _omit, ...partial } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(partial), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when poll_interval_s is not a number", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ ...GOOD_CONFIG, poll_interval_s: "60" }),
      { mode: 0o600 },
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("loads a valid config", () => {
    writeLinearConfig(GOOD_CONFIG);
    const loaded = loadConfig();
    expect(loaded).toMatchObject(GOOD_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// saveLastSyncedAt / flushLastSyncedAt
// ---------------------------------------------------------------------------

describe("saveLastSyncedAt / flushLastSyncedAt", () => {
  beforeEach(() => {
    writeLinearConfig(GOOD_CONFIG);
  });

  it("flushLastSyncedAt persists the pending cursor to disk", () => {
    saveLastSyncedAt("2026-04-27T13:00:00.000Z");
    flushLastSyncedAt();
    expect(loadConfig().last_synced_at).toBe("2026-04-27T13:00:00.000Z");
  });

  it("flushing without a pending value is a no-op", () => {
    const before = loadConfig();
    flushLastSyncedAt();
    expect(loadConfig()).toEqual(before);
  });

  it("coalesces multiple saves (last wins after flush)", () => {
    saveLastSyncedAt("2026-04-27T13:00:00.000Z");
    saveLastSyncedAt("2026-04-27T13:01:00.000Z");
    saveLastSyncedAt("2026-04-27T13:05:00.000Z");
    flushLastSyncedAt();
    expect(loadConfig().last_synced_at).toBe("2026-04-27T13:05:00.000Z");
  });

  it("flushing preserves the rest of the config (does not trample teams or key)", () => {
    saveLastSyncedAt("2026-04-27T14:00:00.000Z");
    flushLastSyncedAt();
    const loaded = loadConfig();
    expect(loaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(loaded.allowlisted_team_ids).toEqual(GOOD_CONFIG.allowlisted_team_ids);
    expect(loaded.poll_interval_s).toBe(60);
    expect(loaded.domain).toBe("linear");
    expect(loaded.last_synced_at).toBe("2026-04-27T14:00:00.000Z");
  });

  it("bails if config was deleted at runtime — does not write back empty creds", () => {
    saveLastSyncedAt("2026-04-27T15:00:00.000Z");
    fs.rmSync(getConfigPath());
    flushLastSyncedAt();
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});
