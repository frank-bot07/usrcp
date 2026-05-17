import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeGmailConfig,
  readPartialConfig,
  loadConfig,
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

describe("legacy plaintext compat", () => {
  it("loads a pre-PR plaintext config and auto-migrates on the next save", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    const loaded = loadConfig(masterKey);
    expect(loaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(loaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);

    saveLastSyncedAt("2026-05-17T17:00:00.000Z", masterKey);
    flushLastSyncedAt();

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.oauth_client_secret.startsWith("enc:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:")).toBe(true);

    const reloaded = loadConfig(masterKey);
    expect(reloaded.oauth_client_secret).toBe(GOOD_CONFIG.oauth_client_secret);
    expect(reloaded.refresh_token).toBe(GOOD_CONFIG.refresh_token);
    expect(reloaded.last_synced_at).toBe("2026-05-17T17:00:00.000Z");
  });
});
