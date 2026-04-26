/**
 * Interactive setup wizard for the USRCP Telegram adapter.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=telegram`).
 * Walks the user through each credential with inline instructions.
 *
 * Exports:
 *   runTelegramSetup()  — full interactive flow; writes telegram-config.json
 */

import { getConfigPath, writeTelegramConfig, type TelegramConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal prompt helpers (no external dep — keeps usrcp-telegram lean)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

export async function runTelegramSetup(): Promise<TelegramConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-telegram setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Telegram adapter setup ────────────────────────────────────┐\n");
  process.stderr.write("  │ I'll walk you through the Telegram credentials.              │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/telegram-config.json                │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Bot token ──────────────────────────────────────────────────────────────
  process.stderr.write("  Step — Telegram bot token\n");
  process.stderr.write("  ──────────────────────────\n");
  process.stderr.write("  1. Open Telegram and message @BotFather\n");
  process.stderr.write("  2. Send /newbot and follow the prompts\n");
  process.stderr.write("  3. Copy the token BotFather sends you (format: 123456:ABC-DEF...)\n\n");

  const telegram_bot_token = await readMaskedLine("  Paste your Telegram bot token: ");
  if (!telegram_bot_token.trim()) {
    console.error("  Error: bot token is required.");
    process.exit(1);
  }
  process.stderr.write("  ✓ Token captured.\n");

  // ── Anthropic key ──────────────────────────────────────────────────────────
  process.stderr.write("\n  Step — Anthropic API key\n");
  process.stderr.write("  ─────────────────────────\n");
  process.stderr.write("  1. Open: https://console.anthropic.com/account/keys\n");
  process.stderr.write("  2. Click 'Create Key' → copy the value\n\n");

  const anthropic_api_key = await readMaskedLine("  Paste your Anthropic API key: ");
  if (!anthropic_api_key.trim()) {
    console.error("  Error: Anthropic API key is required.");
    process.exit(1);
  }
  process.stderr.write("  ✓ Key captured.\n");

  // ── Chat IDs ──────────────────────────────────────────────────────────────
  process.stderr.write("\n  Step — Allowlisted chat IDs\n");
  process.stderr.write("  ────────────────────────────\n");
  process.stderr.write("  Find your chat IDs by forwarding a message to @userinfobot\n");
  process.stderr.write("  or sending any message to @userinfobot from the group.\n");
  process.stderr.write("  Group/supergroup IDs are negative numbers; DM IDs are positive.\n\n");

  let allowlisted_chats: string[] = [];
  while (true) {
    const raw = await readPlainLine(
      "  Paste chat IDs (comma-separated; groups are negative numbers):\n  > "
    );
    const ids = parseChatList(raw);
    if (ids.length === 0) {
      process.stderr.write("  At least one chat ID is required.\n");
      continue;
    }
    allowlisted_chats = ids;
    process.stderr.write(`  ✓ ${ids.length} chat${ids.length === 1 ? "" : "s"} added.\n`);
    break;
  }

  // ── User ID ───────────────────────────────────────────────────────────────
  process.stderr.write("\n  Step — Your Telegram user ID\n");
  process.stderr.write("  ─────────────────────────────\n");
  process.stderr.write("  Send any message to @userinfobot in Telegram — it replies with your ID.\n\n");

  const user_id = (await readPlainLine("  Paste your Telegram user ID: ")).trim();
  if (!user_id) {
    console.error("  Error: user ID is required.");
    process.exit(1);
  }
  process.stderr.write("  ✓ Captured.\n");

  // ── Save ──────────────────────────────────────────────────────────────────
  const cfg: TelegramConfig = {
    telegram_bot_token,
    anthropic_api_key,
    allowlisted_chats,
    user_id,
  };

  writeTelegramConfig(cfg);
  process.stderr.write(`\n  ✓ Config saved to ${getConfigPath()} (mode 0600)\n`);

  return cfg;
}
