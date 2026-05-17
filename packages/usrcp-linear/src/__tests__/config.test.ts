import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeLinearConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  reencryptConfigUnderNewKey,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type LinearConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
// 32-byte test master key; same shape as a real one. The encrypt /
// decrypt helpers derive a global key from this via HKDF so any
// random 32 bytes is fine for tests.
const masterKey = Buffer.alloc(32, 0x42);

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
    writeLinearConfig(GOOD_CONFIG, masterKey);
    const p = getConfigPath();
    expect(fs.existsSync(p)).toBe(true);
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("re-chmods existing file from 0644 → 0600", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{}", { mode: 0o644 });
    writeLinearConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("round-trips a valid config", () => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
    const loaded = loadConfig(masterKey);
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

  it("returns parsed contents on a well-formed file (linear_api_key encrypted on disk)", () => {
    writeLinearConfig({ ...GOOD_CONFIG, last_synced_at: "2026-04-27T00:00:00.000Z" }, masterKey);
    const partial = readPartialConfig();
    // readPartialConfig returns the raw on-disk JSON without
    // decryption. The api key field is the encrypted envelope.
    expect(partial.linear_api_key?.startsWith("enc:")).toBe(true);
    expect(partial.linear_api_key).not.toBe(GOOD_CONFIG.linear_api_key);
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
    expect(() => loadConfig(masterKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when config is malformed JSON", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json{{{");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(masterKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when allowlisted_team_ids is empty", () => {
    writeLinearConfig({ ...GOOD_CONFIG, allowlisted_team_ids: [] }, masterKey);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(masterKey)).toThrow("process.exit called");
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
    expect(() => loadConfig(masterKey)).toThrow("process.exit called");
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
    expect(() => loadConfig(masterKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("loads a valid config", () => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
    const loaded = loadConfig(masterKey);
    expect(loaded).toMatchObject(GOOD_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// saveLastSyncedAt / flushLastSyncedAt
// ---------------------------------------------------------------------------

describe("saveLastSyncedAt / flushLastSyncedAt", () => {
  beforeEach(() => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
  });

  it("flushLastSyncedAt persists the pending cursor to disk", () => {
    saveLastSyncedAt("2026-04-27T13:00:00.000Z", masterKey);
    flushLastSyncedAt();
    expect(loadConfig(masterKey).last_synced_at).toBe("2026-04-27T13:00:00.000Z");
  });

  it("flushing without a pending value is a no-op", () => {
    const before = loadConfig(masterKey);
    flushLastSyncedAt();
    expect(loadConfig(masterKey)).toEqual(before);
  });

  it("coalesces multiple saves (last wins after flush)", () => {
    saveLastSyncedAt("2026-04-27T13:00:00.000Z", masterKey);
    saveLastSyncedAt("2026-04-27T13:01:00.000Z", masterKey);
    saveLastSyncedAt("2026-04-27T13:05:00.000Z", masterKey);
    flushLastSyncedAt();
    expect(loadConfig(masterKey).last_synced_at).toBe("2026-04-27T13:05:00.000Z");
  });

  it("flushing preserves the rest of the config (does not trample teams or key)", () => {
    saveLastSyncedAt("2026-04-27T14:00:00.000Z", masterKey);
    flushLastSyncedAt();
    const loaded = loadConfig(masterKey);
    expect(loaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(loaded.allowlisted_team_ids).toEqual(GOOD_CONFIG.allowlisted_team_ids);
    expect(loaded.poll_interval_s).toBe(60);
    expect(loaded.domain).toBe("linear");
    expect(loaded.last_synced_at).toBe("2026-04-27T14:00:00.000Z");
  });

  it("bails if config was deleted at runtime — does not write back empty creds", () => {
    saveLastSyncedAt("2026-04-27T15:00:00.000Z", masterKey);
    fs.rmSync(getConfigPath());
    flushLastSyncedAt();
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("auto-migrates a legacy plaintext config the moment loadConfig runs (idle adapter case)", () => {
    // Simulate a pre-PR config: linear_api_key stored plaintext.
    const p = getConfigPath();
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    // loadConfig itself rewrites the file as encrypted - we don't
    // wait for saveLastSyncedAt, which only fires if the poll cursor
    // advances and might never happen for an idle workspace.
    const loaded = loadConfig(masterKey);
    expect(loaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.linear_api_key.startsWith("enc:")).toBe(true);

    // Subsequent saves continue to round-trip cleanly.
    saveLastSyncedAt("2026-04-27T16:00:00.000Z", masterKey);
    flushLastSyncedAt();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(reloaded.last_synced_at).toBe("2026-04-27T16:00:00.000Z");
  });

  it("loadConfig errors out when the master key cannot decrypt the on-disk envelope", () => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
    const wrongKey = Buffer.alloc(32, 0xff);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(wrongKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("readPartialDecryptedConfig (setup-wizard defaults)", () => {
  it("returns decrypted plaintext linear_api_key for the wizard's 'Enter to keep' path", () => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
    expect(decrypted.allowlisted_team_ids).toEqual(GOOD_CONFIG.allowlisted_team_ids);
  });

  it("returns empty object when no config exists", () => {
    expect(readPartialDecryptedConfig(masterKey)).toEqual({});
  });

  it("passes through legacy plaintext linear_api_key unchanged", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
  });
});

describe("preflightConfig (no master key required)", () => {
  it("exits when no config file exists", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when a required field is missing", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { linear_api_key: _omit, ...bad } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(bad), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("returns normally on encrypted and on legacy-plaintext configs (no decryption performed)", () => {
    writeLinearConfig(GOOD_CONFIG, masterKey);
    expect(() => preflightConfig()).not.toThrow();

    fs.writeFileSync(getConfigPath(), JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("reencryptConfigUnderNewKey (rotate-key hook)", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  it("returns 'absent' when no config exists", () => {
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("absent");
  });

  it("rewrites an encrypted config so the new key (and only the new key) can decrypt it", () => {
    writeLinearConfig(GOOD_CONFIG, oldKey);
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");

    const reloaded = loadConfig(newKey);
    expect(reloaded.linear_api_key).toBe(GOOD_CONFIG.linear_api_key);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(oldKey)).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("migrates a legacy plaintext config to encrypted under the new key", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.linear_api_key.startsWith("enc:")).toBe(true);
    expect(loadConfig(newKey).linear_api_key).toBe(GOOD_CONFIG.linear_api_key);
  });

  it("preserves mode 0600 after rotation", () => {
    writeLinearConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("throws when the on-disk config is missing required secret fields", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { linear_api_key: _omit, ...incomplete } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => reencryptConfigUnderNewKey(oldKey, newKey)).toThrow(/incomplete linear config/);
  });

  it("leaves no .rotate-tmp.* leftovers after a successful rotation", () => {
    writeLinearConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    const configDir = path.dirname(getConfigPath());
    const leftovers = fs.readdirSync(configDir).filter((n) => n.includes(".rotate-tmp."));
    expect(leftovers).toEqual([]);
  });
});
