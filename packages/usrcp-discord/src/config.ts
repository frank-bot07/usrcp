/**
 * Configuration I/O for the USRCP Discord adapter.
 *
 * Sensitive secrets (`discord_bot_token`, `anthropic_api_key`) are
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
 *   getConfigPath()              path to ~/.usrcp/discord-config.json
 *   writeDiscordConfig()         write encrypted, mode 0600
 *   readPartialConfig()          raw partial read (still-encrypted)
 *   readPartialDecryptedConfig() partial read with envelopes decrypted
 *   loadConfig(masterKey)        read-or-throw non-interactive loader
 *
 * Interactive setup lives in ./setup.ts -> runDiscordSetup().
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

export interface DiscordConfig {
  discord_bot_token: string;
  anthropic_api_key: string;
  allowlisted_channels: string[];
  user_id: string;
}

const CONFIG_FILENAME = "discord-config.json";

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

export function readPartialConfig(): Partial<DiscordConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<DiscordConfig>;
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
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<DiscordConfig> {
  const partial = readPartialConfig();
  const out: Partial<DiscordConfig> = { ...partial };
  try {
    if (partial.discord_bot_token) {
      out.discord_bot_token = maybeDecryptSecret(partial.discord_bot_token, masterKey);
    }
    if (partial.anthropic_api_key) {
      out.anthropic_api_key = maybeDecryptSecret(partial.anthropic_api_key, masterKey);
    }
  } catch {
    /* Best effort: wizard validation will catch decrypt failures. */
  }
  return out;
}

export function writeDiscordConfig(cfg: DiscordConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: DiscordConfig = {
    ...cfg,
    discord_bot_token: encryptSecret(cfg.discord_bot_token, masterKey),
    anthropic_api_key: encryptSecret(cfg.anthropic_api_key, masterKey),
  };
  const body = JSON.stringify(onDisk, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  // O_CREAT mode is a no-op if the file already existed; re-chmod defensively.
  fs.chmodSync(p, 0o600);
}

/**
 * Read + validate the config without decrypting. Exits with a clear
 * "run 'usrcp setup'" message if the file is missing, malformed, or
 * incomplete. Returns the raw partial (with `enc:` envelopes intact)
 * on success.
 *
 * Shared by `preflightConfig` (no masterKey) and `loadConfig`
 * (decrypting variant) so the validation is identical and we don't
 * read disk twice in production code paths that call only one.
 */
function readValidatedPartial(): Partial<DiscordConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-discord: no config found at ${p}.\n` +
      `Run 'usrcp setup' (or 'usrcp setup --adapter=discord') to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<DiscordConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<DiscordConfig>;
  } catch {
    console.error(
      `usrcp-discord: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=discord' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.discord_bot_token) missing.push("discord_bot_token");
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.allowlisted_channels || partial.allowlisted_channels.length === 0) missing.push("allowlisted_channels");
  if (!partial.user_id) missing.push("user_id");
  if (missing.length > 0) {
    console.error(
      `usrcp-discord: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=discord' to re-configure.`
    );
    process.exit(1);
  }
  return partial;
}

/**
 * Validate that the on-disk config exists and is complete, without
 * needing the master key. Daemons MUST call this before constructing
 * the Ledger: `new Ledger(...)` will silently auto-initialize a
 * dev-mode ledger if none exists, which would then poison a later
 * `usrcp setup` run (it'd skip the passphrase prompt because a
 * dev-mode ledger is already there). Preflighting the config first
 * means a missing/incomplete config exits cleanly with no side
 * effects on the user's identity store.
 */
export function preflightConfig(): void {
  readValidatedPartial();
}

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main()
 * after the Ledger is unlocked. If config is missing or incomplete,
 * exits with a clear message pointing the user at 'usrcp setup'.
 */
export function loadConfig(masterKey: Buffer): DiscordConfig {
  const partial = readValidatedPartial();
  let decrypted: DiscordConfig;
  try {
    decrypted = {
      ...(partial as DiscordConfig),
      discord_bot_token: maybeDecryptSecret(partial.discord_bot_token!, masterKey),
      anthropic_api_key: maybeDecryptSecret(partial.anthropic_api_key!, masterKey),
    };
  } catch (err) {
    console.error(
      `usrcp-discord: failed to decrypt config secrets (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  // Auto-migrate legacy plaintext configs the moment we see them, not
  // only when a future setup-wizard run rewrites the file. Discord/
  // Slack/Telegram have no cursor flush path, so without this hook a
  // legacy config would stay plaintext indefinitely after the upgrade.
  const wasLegacyPlaintext =
    !partial.discord_bot_token!.startsWith("enc:") ||
    !partial.anthropic_api_key!.startsWith("enc:");
  if (wasLegacyPlaintext) {
    try {
      writeDiscordConfig(decrypted, masterKey);
    } catch {
      /* Non-fatal; the next setup-wizard save will retry. */
    }
  }
  return decrypted;
}
