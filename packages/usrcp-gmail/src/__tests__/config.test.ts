import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeGmailConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GmailConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
const masterKey = Buffer.alloc(32, 0x42);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-gmail-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: GmailConfig = {
  oauth_client_id: "stub.apps.googleusercontent.com",
  oauth_client_secret: "GOCSPX-test-secret-xxx",
  refresh_token: "1//04stubrefreshtoken",
  poll_interval_s: 600,
  domain: "email",
};

describe("round-trip encryption", () => {
  it("encrypts secrets on disk; loadConfig decrypts back", () => {
    writeGmailConfig(GOOD_CONFIG, masterKey);
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.oauth_client_id).toBe(GOOD_CONFIG.oauth_client_id);
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);

    const loaded = loadConfig(masterKey);
    expect(loaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(loaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);
  });

  it("file is mode 0600", () => {
    writeGmailConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialConfig exposes the raw encrypted envelopes", () => {
    writeGmailConfig(GOOD_CONFIG, masterKey);
    const partial = readPartialConfig();
    expect(partial.oauth_client_secret?.startsWith("enc:")).toBe(true);
    expect(partial.refresh_token?.startsWith("enc:")).toBe(true);
  });

  it("loadConfig fails clearly when the master key cannot decrypt the envelope", () => {
    writeGmailConfig(GOOD_CONFIG, masterKey);
    const wrongKey = Buffer.alloc(32, 0xff);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(wrongKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("readPartialDecryptedConfig (setup-wizard defaults)", () => {
  it("returns decrypted plaintext values for the wizard's 'Enter to keep' path", () => {
    writeGmailConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(decrypted.refresh_token).toBe(GOOD_CONFIG.refresh_token);
    expect(decrypted.oauth_client_id).toBe(GOOD_CONFIG.oauth_client_id);
  });

  it("returns empty object when no config exists", () => {
    expect(readPartialDecryptedConfig(masterKey)).toEqual({});
  });

  it("passes through legacy plaintext values unchanged", () => {
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
    writeGmailConfig(GOOD_CONFIG, masterKey);
    expect(() => preflightConfig()).not.toThrow();

    fs.writeFileSync(getConfigPath(), JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("legacy plaintext compat", () => {
  it("auto-migrates a pre-PR plaintext config the moment loadConfig runs (idle adapter case)", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    // loadConfig itself rewrites the file as encrypted - we don't
    // wait for the next saveLastSyncedAt, which only fires if the
    // poll cursor advances and might never happen for an idle inbox.
    const loaded = loadConfig(masterKey);
    expect(loaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(loaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);

    // Subsequent saves continue to round-trip cleanly.
    saveLastSyncedAt("2026-05-17T17:00:00.000Z", masterKey);
    flushLastSyncedAt();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T17:00:00.000Z");
    expect(reloaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(reloaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);
  });
});
