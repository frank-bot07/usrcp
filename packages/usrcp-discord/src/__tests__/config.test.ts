import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeDiscordConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  reencryptConfigUnderNewKey,
  type DiscordConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
const masterKey = Buffer.alloc(32, 0x42);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-discord-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: DiscordConfig = {
  discord_bot_token: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.GAbCdE.SAMPLE_BOT_TOKEN_VALUE",
  anthropic_api_key: "sk-ant-api03-SAMPLE-ANTHROPIC-KEY",
  allowlisted_channels: ["123456789012345678", "987654321098765432"],
  user_id: "111111111111111111",
};

describe("round-trip encryption", () => {
  it("writes encrypted discord_bot_token + anthropic_api_key; loadConfig decrypts back", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.discord_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);
    expect(raw.user_id).toBe(GOOD_CONFIG.user_id); // not encrypted
    expect(raw.allowlisted_channels).toEqual(GOOD_CONFIG.allowlisted_channels);

    const loaded = loadConfig(masterKey);
    expect(loaded.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
    expect(loaded.user_id).toBe(GOOD_CONFIG.user_id);
    expect(loaded.allowlisted_channels).toEqual(GOOD_CONFIG.allowlisted_channels);
  });

  it("file is mode 0600 after write", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialConfig returns raw on-disk values (encrypted envelopes)", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    const partial = readPartialConfig();
    expect(partial.discord_bot_token?.startsWith("enc:")).toBe(true);
    expect(partial.anthropic_api_key?.startsWith("enc:")).toBe(true);
  });

  it("loadConfig errors out when the master key cannot decrypt the on-disk envelope", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    const wrongKey = Buffer.alloc(32, 0xff);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(wrongKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("readPartialDecryptedConfig", () => {
  it("returns decrypted plaintext values so wizard 'Enter to keep' works on encrypted configs", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(decrypted.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
    expect(decrypted.user_id).toBe(GOOD_CONFIG.user_id);
  });

  it("returns empty object when no config exists", () => {
    expect(readPartialDecryptedConfig(masterKey)).toEqual({});
  });

  it("passes through legacy plaintext values unchanged", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(decrypted.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
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
    const { user_id: _omit, ...bad } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(bad), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("returns normally when an encrypted config is on disk", () => {
    writeDiscordConfig(GOOD_CONFIG, masterKey);
    // preflight does NOT decrypt; it just validates shape.
    expect(() => preflightConfig()).not.toThrow();
  });

  it("returns normally on a legacy plaintext config too (no decryption performed)", () => {
    // Critical: preflight has to succeed for both encrypted and legacy
    // plaintext shapes. Daemons call it before unlocking the master
    // key, so it must not call decrypt() under any branch.
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("legacy plaintext compat", () => {
  it("auto-migrates a pre-PR plaintext config the moment loadConfig runs", () => {
    // Simulate a pre-PR config: secrets stored plaintext.
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    // loadConfig itself rewrites the file as encrypted. Discord has no
    // cursor flush path, so this is the only opportunity to migrate
    // - without it, an idle bot leaves tokens plaintext indefinitely.
    const loaded = loadConfig(masterKey);
    expect(loaded.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.discord_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);

    // And the just-migrated file round-trips cleanly.
    const reloaded = loadConfig(masterKey);
    expect(reloaded.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(reloaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
  });
});

describe("reencryptConfigUnderNewKey (rotate-key hook)", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  it("returns 'absent' when no config exists", () => {
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("absent");
  });

  it("rewrites an encrypted config so the new key (and only the new key) can decrypt it", () => {
    writeDiscordConfig(GOOD_CONFIG, oldKey);
    const result = reencryptConfigUnderNewKey(oldKey, newKey);
    expect(result).toBe("rotated");

    // New key decrypts cleanly.
    const reloaded = loadConfig(newKey);
    expect(reloaded.discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
    expect(reloaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);

    // Old key no longer decrypts (process.exit on GCM auth failure).
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(oldKey)).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("migrates a legacy plaintext config to encrypted under the new key", () => {
    // Pre-#54 config on disk: secrets plaintext.
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    const result = reencryptConfigUnderNewKey(oldKey, newKey);
    expect(result).toBe("rotated");

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.discord_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);

    expect(loadConfig(newKey).discord_bot_token).toBe(GOOD_CONFIG.discord_bot_token);
  });

  it("preserves mode 0600 after rotation", () => {
    writeDiscordConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("throws when the on-disk config is missing required secret fields", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { anthropic_api_key: _omit, ...incomplete } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => reencryptConfigUnderNewKey(oldKey, newKey)).toThrow(/incomplete discord config/);
  });

  it("leaves no .rotate-tmp.* leftovers after a successful rotation", () => {
    writeDiscordConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);

    const configDir = path.dirname(getConfigPath());
    const leftovers = fs.readdirSync(configDir).filter((n) => n.includes(".rotate-tmp."));
    expect(leftovers).toEqual([]);
  });
});
