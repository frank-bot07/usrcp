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
 * Config for the Google Calendar adapter.
 *
 * Sensitive secrets (`oauth_client_secret`, `refresh_token`) are
 * encrypted at rest under the USRCP global encryption key derived
 * from the master key, same envelope (`enc:<base64>`) as
 * private.pem and the ledger's encrypted columns. The file lives
 * at mode 0600 either way; encryption is defense in depth against
 * an attacker who reads disk without unlocking the master key.
 *
 * Legacy plaintext configs (pre-#54) load transparently and are
 * re-encrypted on the next save (e.g. when saveLastSyncedAt fires).
 */
export interface GoogleCalendarConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  /** Long-lived OAuth refresh token. Used to mint short-lived access tokens on each poll. */
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 300 = 5 min). */
  poll_interval_s: number;
  /** ISO timestamp; queries use updatedMin >= last_synced_at. */
  last_synced_at?: string;
}

const CONFIG_FILENAME = "google-calendar-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

/** Encrypt a plaintext secret under the global encryption key. */
function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return encrypt(plaintext, key);
  } finally {
    zeroBuffer(key);
  }
}

/**
 * Decrypt a value if it carries the `enc:` envelope; otherwise return
 * the value as-is (legacy plaintext config produced before this PR).
 * `decrypt()` itself short-circuits on non-`enc:` inputs, so we just
 * call it unconditionally.
 */
function maybeDecryptSecret(value: string, masterKey: Buffer): string {
  if (!value.startsWith("enc:")) return value;
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return decrypt(value, key);
  } finally {
    zeroBuffer(key);
  }
}

/**
 * Raw read of the on-disk JSON without any decryption. Used by
 * flushLastSyncedAt to preserve fields it doesn't unlock, and by
 * tests that want to verify what's actually on disk.
 */
export function readPartialConfig(): Partial<GoogleCalendarConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<GoogleCalendarConfig>;
  } catch {
    return {};
  }
}

export function writeGoogleCalendarConfig(cfg: GoogleCalendarConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: GoogleCalendarConfig = {
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

export function loadConfig(masterKey: Buffer): GoogleCalendarConfig {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-google-calendar: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=google-calendar' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<GoogleCalendarConfig>;
  try {
    partial = JSON.parse(raw) as Partial<GoogleCalendarConfig>;
  } catch {
    console.error(
      `usrcp-google-calendar: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=google-calendar' to re-configure.`
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
      `usrcp-google-calendar: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=google-calendar' to re-configure.`
    );
    process.exit(1);
  }
  // Decrypt the two sensitive fields. Legacy plaintext configs (no
  // enc: prefix) pass through unchanged - the next saveLastSyncedAt
  // tick re-encrypts them.
  let decrypted: GoogleCalendarConfig;
  try {
    decrypted = {
      ...(partial as GoogleCalendarConfig),
      oauth_client_secret: maybeDecryptSecret(partial.oauth_client_secret!, masterKey),
      refresh_token: maybeDecryptSecret(partial.refresh_token!, masterKey),
    };
  } catch (err) {
    console.error(
      `usrcp-google-calendar: failed to decrypt config secrets (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
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
    // Decrypt the on-disk secrets so writeGoogleCalendarConfig can
    // re-encrypt them (it always encrypts on write). This keeps the
    // disk representation stable even when only last_synced_at
    // changes, and incidentally auto-migrates legacy plaintext
    // configs to the encrypted envelope.
    const decrypted: GoogleCalendarConfig = {
      ...(existing as GoogleCalendarConfig),
      oauth_client_secret: maybeDecryptSecret(existing.oauth_client_secret!, _pendingMasterKey),
      refresh_token: maybeDecryptSecret(existing.refresh_token!, _pendingMasterKey),
      last_synced_at: _pendingTs,
    };
    writeGoogleCalendarConfig(decrypted, _pendingMasterKey);
  } catch {
    /* Non-fatal: next restart may re-process a few events. */
  }
  _pendingTs = undefined;
}
