/**
 * First-run interactive configuration for the USRCP Telegram adapter.
 *
 * On first invocation (or with --reset-config) prompts the user for:
 *   - Telegram bot token      (masked input; from BotFather /newbot)
 *   - Anthropic API key       (masked input)
 *   - Allowlisted chat IDs    (comma-separated; negative for groups)
 *   - User's Telegram user ID (from @userinfobot)
 *
 * Persists to ~/.usrcp/telegram-config.json with mode 0600. On subsequent
 * runs, reads from disk and skips the prompts. If any field is missing
 * from an existing config, re-prompts only for the missing ones.
 *
 * Masked input uses raw-mode stdin with per-key redisplay of '*' so the
 * secret never appears in terminal scrollback or shell history. Non-TTY
 * callers (CI, pipes) cannot complete first-run setup — they get a
 * clean error and are told to pre-populate the config file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function readPartialConfig(): Partial<TelegramConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<TelegramConfig>;
  } catch {
    return {};
  }
}

function writeConfig(cfg: TelegramConfig): void {
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

function parseChatList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Load the config, running the interactive first-run prompt if needed.
 * Pass `reset: true` to force re-prompting for all fields.
 */
export async function loadOrInitConfig(opts: { reset?: boolean } = {}): Promise<TelegramConfig> {
  const existing = opts.reset ? {} : readPartialConfig();

  const needsBotToken = !existing.telegram_bot_token;
  const needsAnthropicKey = !existing.anthropic_api_key;
  const needsChats = !existing.allowlisted_chats || existing.allowlisted_chats.length === 0;
  const needsUserId = !existing.user_id;

  const missingAny = needsBotToken || needsAnthropicKey || needsChats || needsUserId;

  if (!missingAny) {
    return existing as TelegramConfig;
  }

  if (!process.stdin.isTTY) {
    const missing: string[] = [];
    if (needsBotToken) missing.push("telegram_bot_token");
    if (needsAnthropicKey) missing.push("anthropic_api_key");
    if (needsChats) missing.push("allowlisted_chats");
    if (needsUserId) missing.push("user_id");
    console.error(
      `usrcp-telegram: missing required config fields (${missing.join(", ")}) ` +
      `and stdin is not a TTY. Pre-populate ${getConfigPath()} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  process.stderr.write("\n  USRCP Telegram — first-run setup\n");
  process.stderr.write(`  Config will be saved to ${getConfigPath()} (mode 0600).\n\n`);

  const telegram_bot_token = needsBotToken
    ? await readMaskedLine("  Telegram bot token (from https://t.me/BotFather → /newbot): ")
    : existing.telegram_bot_token!;

  const anthropic_api_key = needsAnthropicKey
    ? await readMaskedLine("  Anthropic API key (from console.anthropic.com → API Keys): ")
    : existing.anthropic_api_key!;

  const allowlisted_chats = needsChats
    ? parseChatList(
        await readPlainLine(
          "  Allowlisted chat IDs (comma-separated; groups are negative numbers — use @userinfobot to find them): "
        )
      )
    : existing.allowlisted_chats!;

  const user_id = needsUserId
    ? (await readPlainLine("  Your Telegram user ID (send any message to @userinfobot to get it): ")).trim()
    : existing.user_id!;

  if (!telegram_bot_token || !anthropic_api_key || allowlisted_chats.length === 0 || !user_id) {
    console.error("  Error: all fields are required. Re-run with --reset-config to retry.");
    process.exit(1);
  }

  const cfg: TelegramConfig = {
    telegram_bot_token,
    anthropic_api_key,
    allowlisted_chats,
    user_id,
  };
  writeConfig(cfg);
  process.stderr.write(`\n  Config saved to ${getConfigPath()}\n\n`);
  return cfg;
}

export { loadOrInitConfig as runTelegramSetup };
