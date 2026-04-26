/**
 * Configuration I/O for the USRCP Discord adapter.
 *
 * Exports:
 *   getConfigPath()       — path to ~/.usrcp/discord-config.json
 *   writeDiscordConfig()  — write config at mode 0600
 *   readPartialConfig()   — read whatever fields are present on disk
 *   loadConfig()          — read-or-throw (non-interactive)
 *   loadOrInitConfig()    — legacy interactive flow (kept for back-compat)
 *
 * Interactive setup has moved to ./setup.ts → runDiscordSetup().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function readPartialConfig(): Partial<DiscordConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<DiscordConfig>;
  } catch {
    return {};
  }
}

/** @internal — use writeDiscordConfig externally */
function writeConfig(cfg: DiscordConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  // Write with O_WRONLY | O_CREAT | O_TRUNC + 0600. Open via fs.openSync
  // to guarantee the permission bits are honored regardless of umask.
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
 * Read a line with characters echoed as '*'. Returns on \n/\r/EOF.
 * Ctrl-C exits with 130. Backspace / DEL erases one character.
 *
 * Only callable when stdin is a TTY. Caller must check.
 */
function readMaskedLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);

    let buf = "";
    const CODE_NL = 10;
    const CODE_CR = 13;
    const CODE_EOT = 4;
    const CODE_ETX = 3;
    const CODE_BS = 8;
    const CODE_DEL = 127;

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === CODE_NL || code === CODE_CR || code === CODE_EOT) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (code === CODE_ETX) {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (code === CODE_BS || code === CODE_DEL) {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            // Erase one character from the display: cursor-back, space, cursor-back
            process.stderr.write("\b \b");
          }
        } else {
          buf += ch;
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function readPlainLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(chunk.replace(/\r?\n$/, ""));
    };
    stdin.on("data", onData);
  });
}

function parseChannelList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Load the config, running the interactive first-run prompt if needed.
 * Pass `reset: true` to force re-prompting for all fields.
 */
export async function loadOrInitConfig(opts: { reset?: boolean } = {}): Promise<DiscordConfig> {
  const existing = opts.reset ? {} : readPartialConfig();

  const needsDiscordToken = !existing.discord_bot_token;
  const needsAnthropicKey = !existing.anthropic_api_key;
  const needsChannels = !existing.allowlisted_channels || existing.allowlisted_channels.length === 0;
  const needsUserId = !existing.user_id;

  const missingAny = needsDiscordToken || needsAnthropicKey || needsChannels || needsUserId;

  if (!missingAny) {
    return existing as DiscordConfig;
  }

  if (!process.stdin.isTTY) {
    const missing: string[] = [];
    if (needsDiscordToken) missing.push("discord_bot_token");
    if (needsAnthropicKey) missing.push("anthropic_api_key");
    if (needsChannels) missing.push("allowlisted_channels");
    if (needsUserId) missing.push("user_id");
    console.error(
      `usrcp-discord: missing required config fields (${missing.join(", ")}) ` +
      `and stdin is not a TTY. Pre-populate ${getConfigPath()} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  process.stderr.write("\n  USRCP Discord — first-run setup\n");
  process.stderr.write(`  Config will be saved to ${getConfigPath()} (mode 0600).\n\n`);

  const discord_bot_token = needsDiscordToken
    ? await readMaskedLine("  Discord bot token (from Discord Developer Portal → Applications → your app → Bot): ")
    : existing.discord_bot_token!;

  const anthropic_api_key = needsAnthropicKey
    ? await readMaskedLine("  Anthropic API key (from console.anthropic.com → API Keys): ")
    : existing.anthropic_api_key!;

  const allowlisted_channels = needsChannels
    ? parseChannelList(
        await readPlainLine(
          "  Allowlisted channel IDs (comma-separated; right-click a Discord channel → Copy Channel ID with Developer Mode on): "
        )
      )
    : existing.allowlisted_channels!;

  const user_id = needsUserId
    ? (await readPlainLine("  Your Discord user ID (right-click your name → Copy User ID): ")).trim()
    : existing.user_id!;

  if (!discord_bot_token || !anthropic_api_key || allowlisted_channels.length === 0 || !user_id) {
    console.error("  Error: all fields are required. Re-run with --reset-config to retry.");
    process.exit(1);
  }

  const cfg: DiscordConfig = {
    discord_bot_token,
    anthropic_api_key,
    allowlisted_channels,
    user_id,
  };
  writeConfig(cfg);
  process.stderr.write(`\n  ✓ Config saved to ${getConfigPath()}\n\n`);
  return cfg;
}

/**
 * Public alias for writeConfig — used by setup.ts so it doesn't need to
 * re-implement the secure write logic.
 */
export const writeDiscordConfig: (cfg: DiscordConfig) => void = writeConfig;

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main() on
 * every boot. If config is missing or incomplete, exits with a clear message
 * pointing the user at 'usrcp setup'.
 */
export function loadConfig(): DiscordConfig {
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
  return partial as DiscordConfig;
}
