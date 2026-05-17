/**
 * Configuration I/O for the USRCP Telegram adapter.
 *
 * Sensitive secrets (`telegram_bot_token`, `anthropic_api_key`) are
 * encrypted at rest under the USRCP global encryption key derived
 * from the master key, same envelope (`enc:<base64>`) as private.pem
 * and the ledger's encrypted columns. The file lives at mode 0600
 * either way; encryption is defense in depth against an attacker
 * who reads disk without unlocking the master key.
 *
 * Legacy plaintext configs (pre-#55) load transparently and are
 * re-encrypted the moment loadConfig runs.
 *
 * Exports:
 *   getConfigPath()              path to ~/.usrcp/telegram-config.json
 *   writeTelegramConfig()        write encrypted, mode 0600
 *   readPartialConfig()          raw partial read (still-encrypted)
 *   readPartialDecryptedConfig() partial read with envelopes decrypted
 *   loadConfig(masterKey)        read-or-throw non-interactive loader
 *
 * Interactive setup lives in ./setup.ts -> runTelegramSetup().
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

export interface TelegramConfig {
  telegram_bot_token: string;
  anthropic_api_key: string;
  /** Stringified Telegram chat IDs. Groups have negative IDs; stringified for storage parity. */
  allowlisted_chats: string[];
  /** Stringified Telegram user ID of the owner. Only messages from this user are captured. */
  user_id: string;
}

const CONFIG_FILENAME = "telegram-config.json";

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

export function readPartialConfig(): Partial<TelegramConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<TelegramConfig>;
  } catch {
    return {};
  }
}

/**
 * Like readPartialConfig, but decrypts any `enc:<base64>` envelopes
 * back to plaintext. The setup wizard uses this so "Enter to keep
 * existing X" defaults are the actual values the user typed, not the
 * encrypted envelope strings that landed on disk.
 */
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<TelegramConfig> {
  const partial = readPartialConfig();
  const out: Partial<TelegramConfig> = { ...partial };
  try {
    if (partial.telegram_bot_token) {
      out.telegram_bot_token = maybeDecryptSecret(partial.telegram_bot_token, masterKey);
    }
    if (partial.anthropic_api_key) {
      out.anthropic_api_key = maybeDecryptSecret(partial.anthropic_api_key, masterKey);
    }
  } catch {
    /* Best effort: wizard validation will catch decrypt failures. */
  }
  return out;
}

/**
 * Re-encrypt the on-disk config under a new master key. Used during
 * `usrcp_rotate_key` so the rotation doesn't leave this adapter
 * unable to decrypt its bot token / Anthropic key on next boot.
 *
 * Returns "absent" if no config exists; "rotated" if successfully
 * re-encrypted. Throws on parse / decrypt failure - the dispatcher
 * logs the adapter as needing manual re-setup. Atomic per-file
 * (tmp + rename) so the file is either fully old-key or fully new-key.
 */
export function reencryptConfigUnderNewKey(
  oldKey: Buffer,
  newKey: Buffer,
): "absent" | "rotated" {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return "absent";

  const raw = fs.readFileSync(p, "utf8");
  const partial = JSON.parse(raw) as Partial<TelegramConfig>;
  if (!partial.telegram_bot_token || !partial.anthropic_api_key) {
    throw new Error(`incomplete telegram config at ${p}; cannot re-encrypt`);
  }

  const oldGlobal = deriveGlobalEncryptionKey(oldKey);
  const newGlobal = deriveGlobalEncryptionKey(newKey);
  try {
    const passthrough = (v: string) =>
      v.startsWith("enc:") ? decrypt(v, oldGlobal) : v;
    const onDisk = {
      ...partial,
      telegram_bot_token: encrypt(passthrough(partial.telegram_bot_token), newGlobal),
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

export function writeTelegramConfig(cfg: TelegramConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: TelegramConfig = {
    ...cfg,
    telegram_bot_token: encryptSecret(cfg.telegram_bot_token, masterKey),
    anthropic_api_key: encryptSecret(cfg.anthropic_api_key, masterKey),
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

/**
 * Read + validate the config without decrypting. See
 * usrcp-discord/src/config.ts:readValidatedPartial for rationale.
 */
function readValidatedPartial(): Partial<TelegramConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-telegram: no config found at ${p}.\n` +
      `Run 'usrcp setup' (or 'usrcp setup --adapter=telegram') to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<TelegramConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<TelegramConfig>;
  } catch {
    console.error(
      `usrcp-telegram: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=telegram' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.telegram_bot_token) missing.push("telegram_bot_token");
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.allowlisted_chats || partial.allowlisted_chats.length === 0) missing.push("allowlisted_chats");
  if (!partial.user_id) missing.push("user_id");
  if (missing.length > 0) {
    console.error(
      `usrcp-telegram: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=telegram' to re-configure.`
    );
    process.exit(1);
  }
  return partial;
}

/**
 * Validate the on-disk config without needing the master key. Daemons
 * MUST call this before constructing the Ledger to avoid silently
 * auto-initializing a dev-mode ledger on a fresh install that hasn't
 * run `usrcp setup` yet.
 */
export function preflightConfig(): void {
  readValidatedPartial();
}

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main()
 * after the Ledger is unlocked. If config is missing or incomplete,
 * exits with a clear message pointing the user at 'usrcp setup'.
 */
export function loadConfig(masterKey: Buffer): TelegramConfig {
  const partial = readValidatedPartial();
  let decrypted: TelegramConfig;
  try {
    decrypted = {
      ...(partial as TelegramConfig),
      telegram_bot_token: maybeDecryptSecret(partial.telegram_bot_token!, masterKey),
      anthropic_api_key: maybeDecryptSecret(partial.anthropic_api_key!, masterKey),
    };
  } catch (err) {
    console.error(
      `usrcp-telegram: failed to decrypt config secrets (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  const wasLegacyPlaintext =
    !partial.telegram_bot_token!.startsWith("enc:") ||
    !partial.anthropic_api_key!.startsWith("enc:");
  if (wasLegacyPlaintext) {
    try {
      writeTelegramConfig(decrypted, masterKey);
    } catch {
      /* Non-fatal; the next setup-wizard save will retry. */
    }
  }
  return decrypted;
}
