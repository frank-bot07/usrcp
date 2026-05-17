import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeSlackConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  reencryptConfigUnderNewKey,
  type SlackConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
const masterKey = Buffer.alloc(32, 0x42);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-slack-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: SlackConfig = {
  slack_bot_token: "xoxb-SAMPLE-BOT-TOKEN",
  slack_app_token: "xapp-SAMPLE-APP-TOKEN",
  anthropic_api_key: "sk-ant-api03-SAMPLE-ANTHROPIC-KEY",
  allowlisted_channels: ["C01234567", "D89012345"],
  user_id: "U0123ABCD",
};

describe("round-trip encryption", () => {
  it("writes encrypted slack_bot_token + slack_app_token + anthropic_api_key; loadConfig decrypts back", () => {
    writeSlackConfig(GOOD_CONFIG, masterKey);
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.slack_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.slack_app_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);
    expect(raw.user_id).toBe(GOOD_CONFIG.user_id);
    expect(raw.allowlisted_channels).toEqual(GOOD_CONFIG.allowlisted_channels);

    const loaded = loadConfig(masterKey);
    expect(loaded.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(loaded.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);
    expect(loaded.user_id).toBe(GOOD_CONFIG.user_id);
    expect(loaded.allowlisted_channels).toEqual(GOOD_CONFIG.allowlisted_channels);
  });

  it("file is mode 0600 after write", () => {
    writeSlackConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialConfig returns raw on-disk values (encrypted envelopes)", () => {
    writeSlackConfig(GOOD_CONFIG, masterKey);
    const partial = readPartialConfig();
    expect(partial.slack_bot_token?.startsWith("enc:")).toBe(true);
    expect(partial.slack_app_token?.startsWith("enc:")).toBe(true);
    expect(partial.anthropic_api_key?.startsWith("enc:")).toBe(true);
  });

  it("loadConfig errors out when the master key cannot decrypt the on-disk envelope", () => {
    writeSlackConfig(GOOD_CONFIG, masterKey);
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
    writeSlackConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(decrypted.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
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
    expect(decrypted.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(decrypted.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
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
    writeSlackConfig(GOOD_CONFIG, masterKey);
    expect(() => preflightConfig()).not.toThrow();
  });

  it("returns normally on a legacy plaintext config too (no decryption performed)", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("legacy plaintext compat", () => {
  it("auto-migrates a pre-PR plaintext config the moment loadConfig runs", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    const loaded = loadConfig(masterKey);
    expect(loaded.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(loaded.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
    expect(loaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.slack_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.slack_app_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);

    const reloaded = loadConfig(masterKey);
    expect(reloaded.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(reloaded.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
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
    writeSlackConfig(GOOD_CONFIG, oldKey);
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");

    const reloaded = loadConfig(newKey);
    expect(reloaded.slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
    expect(reloaded.slack_app_token).toBe(GOOD_CONFIG.slack_app_token);
    expect(reloaded.anthropic_api_key).toBe(GOOD_CONFIG.anthropic_api_key);

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
    expect(raw.slack_bot_token.startsWith("enc:")).toBe(true);
    expect(raw.slack_app_token.startsWith("enc:")).toBe(true);
    expect(raw.anthropic_api_key.startsWith("enc:")).toBe(true);
    expect(loadConfig(newKey).slack_bot_token).toBe(GOOD_CONFIG.slack_bot_token);
  });

  it("preserves mode 0600 after rotation", () => {
    writeSlackConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("throws when the on-disk config is missing required secret fields", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { slack_app_token: _omit, ...incomplete } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => reencryptConfigUnderNewKey(oldKey, newKey)).toThrow(/incomplete slack config/);
  });

  it("leaves no .rotate-tmp.* leftovers after a successful rotation", () => {
    writeSlackConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    const configDir = path.dirname(getConfigPath());
    const leftovers = fs.readdirSync(configDir).filter((n) => n.includes(".rotate-tmp."));
    expect(leftovers).toEqual([]);
  });
});
