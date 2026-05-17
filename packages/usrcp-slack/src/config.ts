/**
 * Configuration I/O for the USRCP Slack adapter.
 *
 * Sensitive secrets (`slack_bot_token`, `slack_app_token`,
 * `anthropic_api_key`) are encrypted at rest under the USRCP global
 * encryption key derived from the master key, same envelope
 * (`enc:<base64>`) as private.pem and the ledger's encrypted
 * columns. The file lives at mode 0600 either way; encryption is
 * defense in depth against an attacker who reads disk without
 * unlocking the master key.
 *
 * Legacy plaintext configs (pre-#55) load transparently and are
 * re-encrypted the moment loadConfig runs.
 *
 * Exports:
 *   getConfigPath()              path to ~/.usrcp/slack-config.json
 *   writeSlackConfig()           write encrypted, mode 0600
 *   readPartialConfig()          raw partial read (still-encrypted)
 *   readPartialDecryptedConfig() partial read with envelopes decrypted
 *   loadConfig(masterKey)        read-or-throw non-interactive loader
 *
 * Interactive setup lives in ./setup.ts -> runSlackSetup().
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

export interface SlackConfig {
  slack_bot_token: string;        // xoxb-...
  slack_app_token: string;        // xapp-...
  anthropic_api_key: string;
  allowlisted_channels: string[]; // C... or D... IDs
  user_id: string;                // U... - the workspace user ID (not the bot's)
}

const CONFIG_FILENAME = "slack-config.json";

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

export function readPartialConfig(): Partial<SlackConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConfig>;
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
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<SlackConfig> {
  const partial = readPartialConfig();
  const out: Partial<SlackConfig> = { ...partial };
  try {
    if (partial.slack_bot_token) {
      out.slack_bot_token = maybeDecryptSecret(partial.slack_bot_token, masterKey);
    }
    if (partial.slack_app_token) {
      out.slack_app_token = maybeDecryptSecret(partial.slack_app_token, masterKey);
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
 * unable to decrypt its tokens on next boot.
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
  const partial = JSON.parse(raw) as Partial<SlackConfig>;
  if (!partial.slack_bot_token || !partial.slack_app_token || !partial.anthropic_api_key) {
    throw new Error(`incomplete slack config at ${p}; cannot re-encrypt`);
  }

  const oldGlobal = deriveGlobalEncryptionKey(oldKey);
  const newGlobal = deriveGlobalEncryptionKey(newKey);
  try {
    const passthrough = (v: string) =>
      v.startsWith("enc:") ? decrypt(v, oldGlobal) : v;
    const onDisk = {
      ...partial,
      slack_bot_token: encrypt(passthrough(partial.slack_bot_token), newGlobal),
      slack_app_token: encrypt(passthrough(partial.slack_app_token), newGlobal),
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

export function writeSlackConfig(cfg: SlackConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: SlackConfig = {
    ...cfg,
    slack_bot_token: encryptSecret(cfg.slack_bot_token, masterKey),
    slack_app_token: encryptSecret(cfg.slack_app_token, masterKey),
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
function readValidatedPartial(): Partial<SlackConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-slack: no config found at ${p}.\n` +
      `Run 'usrcp setup' (or 'usrcp setup --adapter=slack') to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<SlackConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConfig>;
  } catch {
    console.error(
      `usrcp-slack: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=slack' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.slack_bot_token) missing.push("slack_bot_token");
  if (!partial.slack_app_token) missing.push("slack_app_token");
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.allowlisted_channels || partial.allowlisted_channels.length === 0) missing.push("allowlisted_channels");
  if (!partial.user_id) missing.push("user_id");
  if (missing.length > 0) {
    console.error(
      `usrcp-slack: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=slack' to re-configure.`
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
export function loadConfig(masterKey: Buffer): SlackConfig {
  const partial = readValidatedPartial();
  let decrypted: SlackConfig;
  try {
    decrypted = {
      ...(partial as SlackConfig),
      slack_bot_token: maybeDecryptSecret(partial.slack_bot_token!, masterKey),
      slack_app_token: maybeDecryptSecret(partial.slack_app_token!, masterKey),
      anthropic_api_key: maybeDecryptSecret(partial.anthropic_api_key!, masterKey),
    };
  } catch (err) {
    console.error(
      `usrcp-slack: failed to decrypt config secrets (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  const wasLegacyPlaintext =
    !partial.slack_bot_token!.startsWith("enc:") ||
    !partial.slack_app_token!.startsWith("enc:") ||
    !partial.anthropic_api_key!.startsWith("enc:");
  if (wasLegacyPlaintext) {
    try {
      writeSlackConfig(decrypted, masterKey);
    } catch {
      /* Non-fatal; the next setup-wizard save will retry. */
    }
  }
  return decrypted;
}
