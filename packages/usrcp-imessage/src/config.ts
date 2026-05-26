/**
 * Configuration I/O for the USRCP iMessage adapter.
 *
 * The sensitive `anthropic_api_key` field is encrypted at rest under
 * the USRCP global encryption key derived from the master key — same
 * `enc:<base64>` envelope as private.pem and the ledger's encrypted
 * columns. Matches the Slack / Discord / Telegram / GitHub / Gmail
 * adapters. The file lives at mode 0600 either way; encryption is
 * defense in depth against an attacker who reads disk without
 * unlocking the master key.
 *
 * Legacy plaintext configs (pre-v0.1.3) load transparently and are
 * re-encrypted the next time `writeImessageConfig` runs (typically
 * the next setup-wizard run or the next `usrcp_rotate_key`).
 *
 * Exports:
 *   getConfigPath()              path to ~/.usrcp/imessage-config.json
 *   writeImessageConfig()        write encrypted, mode 0600
 *   readPartialConfig()          raw partial read (still-encrypted)
 *   readPartialDecryptedConfig() partial read with envelopes decrypted
 *   loadConfig(masterKey)        read-or-throw non-interactive loader
 *   reencryptConfigUnderNewKey() rotation dispatcher hook
 *   saveLastRowid()              debounced cursor persistence
 *
 * Interactive setup lives in ./setup.ts -> runImessageSetup().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  deriveGlobalEncryptionKey,
  zeroBuffer,
} from "usrcp-local/dist/encryption.js";

export interface ImessageConfig {
  anthropic_api_key: string;
  /** User's own iMessage handle — phone (e.g. +14155551234) or email. */
  user_handle: string;
  /** Chat ROWIDs (as strings) from chat.db — stable per install. */
  allowlisted_chats: string[];
  /** Trigger prefix for group chats. Default: "..u " */
  prefix: string;
  /** Resume cursor for `imsg watch --since-rowid`. Updated per-event. */
  last_rowid?: number;
}

const CONFIG_FILENAME = "imessage-config.json";

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

/** Raw on-disk read, no decryption — useful for the rotation path. */
export function readPartialConfig(): Partial<ImessageConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ImessageConfig>;
  } catch {
    return {};
  }
}

/**
 * Read with `enc:<base64>` envelopes decrypted back to plaintext.
 * Used by the setup wizard so "Enter to keep existing X" defaults
 * are the actual values the user typed, not the encrypted strings.
 */
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<ImessageConfig> {
  const partial = readPartialConfig();
  const out: Partial<ImessageConfig> = { ...partial };
  try {
    if (partial.anthropic_api_key) {
      out.anthropic_api_key = maybeDecryptSecret(partial.anthropic_api_key, masterKey);
    }
  } catch {
    /* Best effort: wizard validation will catch decrypt failures. */
  }
  return out;
}

/** @internal — atomic mode-0600 raw writer; takes already-shaped on-disk JSON. */
function writeConfigRaw(cfg: ImessageConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  // Write with O_WRONLY | O_CREAT | O_TRUNC + 0600. Use fs.openSync to
  // guarantee permission bits are honored regardless of umask.
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  // Re-chmod defensively — openSync with mode only sets perms on creation.
  // If the file already existed, O_CREAT is a no-op and perms may stay stale.
  fs.chmodSync(p, 0o600);
}

/**
 * Public writer — encrypts `anthropic_api_key` under the global key,
 * then writes the resulting on-disk shape atomically at mode 0600.
 */
export function writeImessageConfig(cfg: ImessageConfig, masterKey: Buffer): void {
  const onDisk: ImessageConfig = {
    ...cfg,
    anthropic_api_key: encryptSecret(cfg.anthropic_api_key, masterKey),
  };
  writeConfigRaw(onDisk);
}

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main() on
 * every boot. If config is missing or incomplete, exits with a clear message.
 * Decrypts any `enc:<base64>` envelopes before returning.
 */
export function loadConfig(masterKey: Buffer): ImessageConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-imessage: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=imessage' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<ImessageConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ImessageConfig>;
  } catch {
    console.error(
      `usrcp-imessage: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=imessage' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.user_handle) missing.push("user_handle");
  if (!partial.allowlisted_chats || partial.allowlisted_chats.length === 0) missing.push("allowlisted_chats");
  if (!partial.prefix) missing.push("prefix");
  if (missing.length > 0) {
    console.error(
      `usrcp-imessage: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=imessage' to re-configure.`
    );
    process.exit(1);
  }

  // Decrypt the API key. If still plaintext (pre-v0.1.3 legacy config),
  // pass through unchanged — the next writeImessageConfig will encrypt
  // it on disk. Wizard runs trigger this; non-wizard runtime does not.
  let apiKey: string;
  try {
    apiKey = maybeDecryptSecret(partial.anthropic_api_key as string, masterKey);
  } catch {
    console.error(
      `usrcp-imessage: failed to decrypt anthropic_api_key at ${p}.\n` +
      `This usually means the master key has changed since the config was written.\n` +
      `Run 'usrcp setup --adapter=imessage' to re-configure.`
    );
    process.exit(1);
  }

  return { ...(partial as ImessageConfig), anthropic_api_key: apiKey };
}

/**
 * Re-encrypt the on-disk config under a new master key. Called by the
 * usrcp_rotate_key dispatcher so rotation doesn't leave this adapter
 * unable to decrypt its API key on next boot.
 *
 * Returns "absent" if no config exists; "rotated" if successfully
 * re-encrypted. Throws on parse / decrypt failure - the dispatcher
 * logs the adapter as needing manual re-setup. Atomic per-file (tmp +
 * rename) so the file is either fully old-key or fully new-key.
 */
export function reencryptConfigUnderNewKey(
  oldKey: Buffer,
  newKey: Buffer,
): "absent" | "rotated" {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return "absent";

  const raw = fs.readFileSync(p, "utf8");
  const partial = JSON.parse(raw) as Partial<ImessageConfig>;
  if (!partial.anthropic_api_key) {
    throw new Error(`incomplete imessage config at ${p}; cannot re-encrypt`);
  }

  const oldGlobal = deriveGlobalEncryptionKey(oldKey);
  const newGlobal = deriveGlobalEncryptionKey(newKey);
  try {
    const passthrough = (v: string) =>
      v.startsWith("enc:") ? decrypt(v, oldGlobal) : v;
    const onDisk = {
      ...partial,
      anthropic_api_key: encrypt(passthrough(partial.anthropic_api_key), newGlobal),
    };
    const body = JSON.stringify(onDisk, null, 2);
    const tmp = `${p}.rotate-tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
    return "rotated";
  } finally {
    zeroBuffer(oldGlobal);
    zeroBuffer(newGlobal);
  }
}

// ---------------------------------------------------------------------------
// Debounced last_rowid persistence
//
// saveLastRowid() is called per-event in the hot path. We coalesce writes
// via a 500ms debounce timer so disk I/O doesn't track every message.
// On SIGINT the caller flushes explicitly (flushLastRowid()).
//
// The flush merges the new rowid into the EXISTING on-disk config and
// writes it back AS-IS. The encrypted `anthropic_api_key` envelope is
// preserved verbatim — we never decrypt + re-encrypt in the hot path
// (which would also need the masterKey, breaking the cursor-write
// contract that today is fire-and-forget).
// ---------------------------------------------------------------------------

let _pendingRowid: number | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesced in-memory update; flushes to disk after 500ms of quiet. */
export function saveLastRowid(rowid: number): void {
  _pendingRowid = rowid;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushLastRowid();
  }, 500);
}

/** Immediately flush any pending rowid to disk. Call on SIGINT/SIGTERM. */
export function flushLastRowid(): void {
  if (_pendingRowid === undefined) return;
  const existing = readPartialConfig();
  // Pass-through merge: keep existing fields (including the encrypted
  // anthropic_api_key envelope) verbatim, just update last_rowid.
  const merged: ImessageConfig = {
    anthropic_api_key: existing.anthropic_api_key ?? "",
    user_handle: existing.user_handle ?? "",
    allowlisted_chats: existing.allowlisted_chats ?? [],
    prefix: existing.prefix ?? "..u ",
    ...existing,
    last_rowid: _pendingRowid,
  };
  try {
    writeConfigRaw(merged);
  } catch {
    // Non-fatal — next restart may re-process a few events
  }
  _pendingRowid = undefined;
}
