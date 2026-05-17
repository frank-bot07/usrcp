import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeGoogleCalendarConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  reencryptConfigUnderNewKey,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GoogleCalendarConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
const masterKey = Buffer.alloc(32, 0x42);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-gcal-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: GoogleCalendarConfig = {
  oauth_client_id: "stub.apps.googleusercontent.com",
  oauth_client_secret: "GOCSPX-test-secret-xxx",
  refresh_token: "1//04stubrefreshtoken",
  poll_interval_s: 300,
  domain: "calendar",
};

describe("round-trip encryption", () => {
  it("writes encrypted oauth_client_secret + refresh_token; loadConfig decrypts back to plaintext", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.oauth_client_id).toBe(GOOD_CONFIG.oauth_client_id); // not encrypted
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);

    const loaded = loadConfig(masterKey);
    expect(loaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(loaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);
    expect(loaded.oauth_client_id).toBe(GOOD_CONFIG.oauth_client_id);
  });

  it("file is mode 0600 after write", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialConfig returns raw on-disk values (encrypted envelopes)", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    const partial = readPartialConfig();
    expect(partial.oauth_client_secret?.startsWith("enc:")).toBe(true);
    expect(partial.refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("loadConfig errors out when the master key cannot decrypt the on-disk envelope", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    const wrongKey = Buffer.alloc(32, 0xff);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(wrongKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("readPartialDecryptedConfig (setup-wizard defaults)", () => {
  it("returns decrypted plaintext values so wizard 'Enter to keep' works on encrypted configs", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(decrypted.refresh_token).toBe(GOOD_CONFIG.refresh_token);
    // Plaintext envelope-free values come through too.
    expect(decrypted.oauth_client_id).toBe(GOOD_CONFIG.oauth_client_id);
    expect(decrypted.domain).toBe(GOOD_CONFIG.domain);
  });

  it("returns empty object when no config exists", () => {
    expect(readPartialDecryptedConfig(masterKey)).toEqual({});
  });

  it("passes through legacy plaintext values unchanged", () => {
    // Pre-PR config (plaintext secrets).
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(decrypted.refresh_token).toBe(GOOD_CONFIG.refresh_token);
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
    const { refresh_token: _omit, ...bad } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(bad), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("returns normally on encrypted and on legacy-plaintext configs (no decryption performed)", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, masterKey);
    expect(() => preflightConfig()).not.toThrow();

    // Replace with legacy plaintext on disk - preflight must still succeed.
    fs.writeFileSync(getConfigPath(), JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("legacy plaintext compat", () => {
  it("auto-migrates a pre-PR plaintext config the moment loadConfig runs (idle adapter case)", () => {
    // Simulate a pre-PR config: secrets in plaintext.
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    // loadConfig itself re-writes the file as encrypted; we do NOT
    // depend on saveLastSyncedAt firing (which only happens if the
    // poll cursor advances - might never happen for an idle inbox /
    // calendar).
    const loaded = loadConfig(masterKey);
    expect(loaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(loaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);

    // Subsequent saves continue to round-trip cleanly.
    saveLastSyncedAt("2026-05-17T16:00:00.000Z", masterKey);
    flushLastSyncedAt();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T16:00:00.000Z");
    expect(reloaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(reloaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);
  });
});

describe("reencryptConfigUnderNewKey (rotate-key hook)", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  it("returns 'absent' when no config exists", () => {
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("absent");
  });

  it("rewrites an encrypted config so the new key (and only the new key) can decrypt it", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, oldKey);
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");

    const reloaded = loadConfig(newKey);
    expect(reloaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(reloaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);

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
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);
    expect(loadConfig(newKey).refresh_token).toBe(GOOD_CONFIG.refresh_token);
  });

  it("preserves mode 0600 after rotation", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("throws when the on-disk config is missing required secret fields", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { refresh_token: _omit, ...incomplete } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => reencryptConfigUnderNewKey(oldKey, newKey)).toThrow(/incomplete google-calendar config/);
  });

  it("leaves no .rotate-tmp.* leftovers after a successful rotation", () => {
    writeGoogleCalendarConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    const configDir = path.dirname(getConfigPath());
    const leftovers = fs.readdirSync(configDir).filter((n) => n.includes(".rotate-tmp."));
    expect(leftovers).toEqual([]);
  });
});
