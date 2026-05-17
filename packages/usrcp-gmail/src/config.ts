import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  deriveGlobalEncryptionKey,
  zeroBuffer,
} from "usrcp-local/dist/encryption.js";

/**
 * Config for the Gmail adapter. Sensitive secrets
 * (`oauth_client_secret`, `refresh_token`) are encrypted at rest
 * under the USRCP global encryption key derived from the master
 * key; the file lives at mode 0600 either way. Legacy plaintext
 * configs (pre-#54) load transparently and are re-encrypted on the
 * next save.
 */
export interface GmailConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 600 = 10 min). */
  poll_interval_s: number;
  /**
   * ISO timestamp; queries use `after:` Gmail-query syntax with the
   * unix seconds form of this value. Gmail's search resolution is
   * 1 second, so the cursor advances in seconds.
   */
  last_synced_at?: string;
}

const CONFIG_FILENAME = "gmail-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return encrypt(plaintext, key);
  } finally {
    zeroBuffer(key);
  }
}

function maybeDecryptSecret(value: string, masterKey: Buffer): string {
  if (!value.startsWith("enc:")) return value;
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return decrypt(value, key);
  } finally {
    zeroBuffer(key);
  }
}

export function readPartialConfig(): Partial<GmailConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<GmailConfig>;
  } catch {
    return {};
  }
}

/**
 * Like readPartialConfig, but decrypts any `enc:<base64>` envelopes
 * back to plaintext. The wizard uses this so "Enter to keep existing
 * X" defaults are the actual values the user typed, not the
 * encrypted envelope strings that landed on disk.
 */
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<GmailConfig> {
  const partial = readPartialConfig();
  const out: Partial<GmailConfig> = { ...partial };
  try {
    if (partial.oauth_client_secret) {
      out.oauth_client_secret = maybeDecryptSecret(partial.oauth_client_secret, masterKey);
    }
    if (partial.refresh_token) {
      out.refresh_token = maybeDecryptSecret(partial.refresh_token, masterKey);
    }
  } catch {
    /* Best effort: wizard validation will catch decrypt failures. */
  }
  return out;
}

export function writeGmailConfig(cfg: GmailConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: GmailConfig = {
    ...cfg,
    oauth_client_secret: encryptSecret(cfg.oauth_client_secret, masterKey),
    refresh_token: encryptSecret(cfg.refresh_token, masterKey),
  };
  const body = JSON.stringify(onDisk, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(p, 0o600);
}

export function loadConfig(masterKey: Buffer): GmailConfig {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-gmail: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=gmail' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<GmailConfig>;
  try {
    partial = JSON.parse(raw) as Partial<GmailConfig>;
  } catch {
    console.error(
      `usrcp-gmail: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=gmail' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.oauth_client_id) missing.push("oauth_client_id");
  if (!partial.oauth_client_secret) missing.push("oauth_client_secret");
  if (!partial.refresh_token) missing.push("refresh_token");
  if (!partial.domain) missing.push("domain");
  if (typeof partial.poll_interval_s !== "number") missing.push("poll_interval_s");
  if (missing.length > 0) {
    console.error(
      `usrcp-gmail: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=gmail' to re-configure.`
    );
    process.exit(1);
  }
  let decrypted: GmailConfig;
  try {
    decrypted = {
      ...(partial as GmailConfig),
      oauth_client_secret: maybeDecryptSecret(partial.oauth_client_secret!, masterKey),
      refresh_token: maybeDecryptSecret(partial.refresh_token!, masterKey),
    };
  } catch (err) {
    console.error(
      `usrcp-gmail: failed to decrypt config secrets (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  return decrypted;
}

let _pendingTs: string | undefined;
let _pendingMasterKey: Buffer | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

export function saveLastSyncedAt(ts: string, masterKey: Buffer): void {
  _pendingTs = ts;
  _pendingMasterKey = masterKey;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushLastSyncedAt();
  }, 500);
}

export function flushLastSyncedAt(): void {
  if (_pendingTs === undefined || !_pendingMasterKey) return;
  const existing = readPartialConfig();
  if (
    !existing.oauth_client_id ||
    !existing.oauth_client_secret ||
    !existing.refresh_token ||
    !existing.domain ||
    typeof existing.poll_interval_s !== "number"
  ) {
    _pendingTs = undefined;
    return;
  }
  try {
    const decrypted: GmailConfig = {
      ...(existing as GmailConfig),
      oauth_client_secret: maybeDecryptSecret(existing.oauth_client_secret!, _pendingMasterKey),
      refresh_token: maybeDecryptSecret(existing.refresh_token!, _pendingMasterKey),
      last_synced_at: _pendingTs,
    };
    writeGmailConfig(decrypted, _pendingMasterKey);
  } catch {
    /* Non-fatal: next restart may re-process a few messages. */
  }
  _pendingTs = undefined;
}
