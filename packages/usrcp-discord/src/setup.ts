/**
 * Interactive setup wizard for the USRCP Discord adapter.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=discord`).
 * Walks the user through every credential with inline instructions,
 * validation against the Discord API, and proactive trap warnings.
 *
 * Exports:
 *   runDiscordSetup()  — full interactive flow; writes discord-config.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import { execSync } from "node:child_process";
import { getConfigPath, writeDiscordConfig, type DiscordConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal masked-input prompt (no external dep needed here — the wizard in
// usrcp-local uses @inquirer/prompts, but the Discord package stays lean).
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

function readYN(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return readPlainLine(`${prompt} ${hint} `).then((ans) => {
    const a = ans.trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  });
}

// ---------------------------------------------------------------------------
// Discord API helpers
// ---------------------------------------------------------------------------

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
}

interface DiscordApplication {
  id: string;
  flags: number;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function validateBotToken(token: string): Promise<
  | { ok: true; user: DiscordUser }
  | { ok: false; reason: string }
> {
  try {
    const { status, body } = await httpsGet(
      "https://discord.com/api/v10/users/@me",
      { Authorization: `Bot ${token}` }
    );
    if (status === 200) {
      const user = JSON.parse(body) as DiscordUser;
      return { ok: true, user };
    }
    if (status === 401) return { ok: false, reason: "Invalid token (401 Unauthorized)." };
    return { ok: false, reason: `Unexpected HTTP ${status}.` };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const MESSAGE_CONTENT_FLAG = 1 << 19;         // GATEWAY_MESSAGE_CONTENT (unverified bots)
const MESSAGE_CONTENT_LIMITED_FLAG = 1 << 18; // GATEWAY_MESSAGE_CONTENT_LIMITED (verified bots)

async function checkMessageContentIntent(token: string): Promise<
  | { ok: true; botId: string }
  | { ok: false; botId: string; reason: string }
> {
  try {
    const { status, body } = await httpsGet(
      "https://discord.com/api/v10/applications/@me",
      { Authorization: `Bot ${token}` }
    );
    if (status === 200) {
      const app = JSON.parse(body) as DiscordApplication;
      const hasIntent =
        (app.flags & MESSAGE_CONTENT_FLAG) !== 0 ||
        (app.flags & MESSAGE_CONTENT_LIMITED_FLAG) !== 0;
      if (hasIntent) return { ok: true, botId: app.id };
      return { ok: false, botId: app.id, reason: "MESSAGE_CONTENT intent not enabled." };
    }
    return { ok: false, botId: "", reason: `Unexpected HTTP ${status} from /applications/@me.` };
  } catch (err) {
    return { ok: false, botId: "", reason: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function validateAnthropicKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
  // Dynamic import of @anthropic-ai/sdk (only available in usrcp-discord which has it as a dep)
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("invalid x-api-key") || msg.includes("authentication")) {
      return { ok: false, reason: "Invalid API key (401)." };
    }
    // Any other error (network, rate-limit) — pass through as valid (fail-fast is for auth only)
    return { ok: true };
  }
}

function tryOpenUrl(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") execSync(`open "${url}"`, { stdio: "ignore" });
    else if (platform === "linux") execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    else if (platform === "win32") execSync(`start "" "${url}"`, { stdio: "ignore", shell: "/bin/sh" });
  } catch {
    // ignore — user will open manually
  }
}

function parseIdList(raw: string): string[] {
  // Accept comma-separated or whitespace-separated or JSON array
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      return (JSON.parse(trimmed) as unknown[]).map(String).filter((s) => s.length > 0);
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SNOWFLAKE_RE = /^\d{17,20}$/;
function isValidSnowflake(id: string): boolean {
  return SNOWFLAKE_RE.test(id);
}

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

export async function runDiscordSetup(): Promise<DiscordConfig> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-discord setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Discord adapter setup ─────────────────────────────────────┐\n");
  process.stderr.write("  │ I'll walk you through four credentials. Each is validated     │\n");
  process.stderr.write("  │ before we move on. Config saved to ~/.usrcp/discord-config.json │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── 3a. Bot token ──────────────────────────────────────────────────────────
  process.stderr.write("  Step 3a — Discord bot token\n");
  process.stderr.write("  ─────────────────────────────\n");
  process.stderr.write("  1. Open: https://discord.com/developers/applications\n");
  process.stderr.write("  2. Click 'New Application' → name it (e.g., 'usrcp-dev')\n");
  process.stderr.write("  3. Sidebar → 'Bot' → 'Reset Token' → copy the value\n");
  process.stderr.write("  4. On the SAME page scroll to 'Privileged Gateway Intents'\n");
  process.stderr.write("     and toggle ON 'MESSAGE CONTENT INTENT'\n");
  process.stderr.write("     (Without this, message capture silently does nothing.)\n\n");

  const autoOpenPortal = await readYN("  Auto-open the developer portal now?");
  if (autoOpenPortal) tryOpenUrl("https://discord.com/developers/applications");

  let discord_bot_token = "";
  let botUser: DiscordUser | null = null;
  let botId = "";

  while (true) {
    discord_bot_token = await readMaskedLine("\n  Paste your bot token: ");
    if (!discord_bot_token.trim()) {
      process.stderr.write("  Token cannot be empty. Try again.\n");
      continue;
    }
    process.stderr.write("  Validating token...\n");
    const tokenResult = await validateBotToken(discord_bot_token);
    if (!tokenResult.ok) {
      process.stderr.write(`  ${tokenResult.reason} Try again.\n`);
      continue;
    }
    botUser = tokenResult.user;
    process.stderr.write(
      `  ✓ Bot logged in as ${botUser.username}#${botUser.discriminator}\n`
    );

    // Check MESSAGE_CONTENT intent
    process.stderr.write("  Checking MESSAGE_CONTENT_INTENT...\n");
    const intentResult = await checkMessageContentIntent(discord_bot_token);
    botId = intentResult.botId || botUser.id;

    if (!intentResult.ok) {
      process.stderr.write("\n");
      process.stderr.write("  ⚠ MESSAGE_CONTENT_INTENT is NOT enabled.\n");
      process.stderr.write("  Without it, the bot receives message events with empty .content\n");
      process.stderr.write("  and capture silently fails.\n\n");
      process.stderr.write("  To fix:\n");
      process.stderr.write("    Discord Developer Portal → your app → Bot\n");
      process.stderr.write("    → Privileged Gateway Intents → toggle ON 'MESSAGE CONTENT INTENT'\n\n");
      const retry = await readYN("  I've enabled it. Re-check?");
      if (retry) continue; // re-validate
      // User declined — warn but proceed
      process.stderr.write("  ⚠ Proceeding without MESSAGE_CONTENT_INTENT. Capture may not work.\n");
    } else {
      process.stderr.write("  ✓ MESSAGE_CONTENT_INTENT is enabled.\n");
    }
    break;
  }

  // ── 3b. Invite the bot ────────────────────────────────────────────────────
  process.stderr.write("\n  Step 3b — Invite the bot to your server\n");
  process.stderr.write("  ─────────────────────────────────────────\n");

  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${botId}&permissions=274877910016&scope=bot`;
  process.stderr.write(`  Invite URL (auto-generated with correct permissions):\n`);
  process.stderr.write(`  ${inviteUrl}\n\n`);
  process.stderr.write("  Permissions granted: View Channels + Send Messages + Read Message History\n\n");

  const autoOpenInvite = await readYN("  Auto-open the invite URL?");
  if (autoOpenInvite) tryOpenUrl(inviteUrl);

  await readYN("  Have you invited the bot to your server?", true);

  process.stderr.write("\n");
  process.stderr.write("  ⚠ IMPORTANT — managed role rename:\n");
  process.stderr.write("  Discord auto-creates a role named the same as your bot (e.g., 'usrcp-dev').\n");
  process.stderr.write("  When typing @usrcp-dev, autocomplete shows BOTH the bot user AND the role.\n");
  process.stderr.write("  Picking the role makes @-mentions silently NOT trigger replies.\n\n");
  process.stderr.write("  Fix now:\n");
  process.stderr.write("    Server Settings → Roles → find the bot's role name → rename to\n");
  process.stderr.write("    something like 'usrcp-bot-role' (anything that won't collide).\n\n");

  await readYN("  Have you renamed (or noted) the managed role?", true);

  // ── 3c. Anthropic API key ─────────────────────────────────────────────────
  process.stderr.write("\n  Step 3c — Anthropic API key\n");
  process.stderr.write("  ─────────────────────────────\n");
  process.stderr.write("  1. Open: https://console.anthropic.com/account/keys\n");
  process.stderr.write("  2. Click 'Create Key' → copy the value (starts with sk-ant-api03-...)\n\n");

  const autoOpenAnthropic = await readYN("  Auto-open console.anthropic.com?");
  if (autoOpenAnthropic) tryOpenUrl("https://console.anthropic.com/account/keys");

  let anthropic_api_key = "";
  while (true) {
    anthropic_api_key = await readMaskedLine("\n  Paste your Anthropic API key: ");
    if (!anthropic_api_key.trim()) {
      process.stderr.write("  Key cannot be empty. Try again.\n");
      continue;
    }
    process.stderr.write("  Validating key (1-token test call)...\n");
    const keyResult = await validateAnthropicKey(anthropic_api_key);
    if (!keyResult.ok) {
      process.stderr.write(`  ${keyResult.reason ?? "Invalid key."} Try again.\n`);
      continue;
    }
    process.stderr.write("  ✓ Anthropic key works. Default model: claude-haiku-4-5.\n");
    break;
  }

  // ── 3d. Channel IDs ───────────────────────────────────────────────────────
  process.stderr.write("\n  Step 3d — Allowlisted channel IDs\n");
  process.stderr.write("  ───────────────────────────────────\n");
  process.stderr.write("  Enable Developer Mode first (if not done):\n");
  process.stderr.write("    Discord → User Settings → Advanced → Developer Mode ON\n\n");
  process.stderr.write("  Then right-click each channel you want to enroll → 'Copy Channel ID'\n\n");

  let allowlisted_channels: string[] = [];
  while (true) {
    const raw = await readPlainLine("  Paste channel IDs (comma-separated or JSON array):\n  > ");
    const ids = parseIdList(raw);
    if (ids.length === 0) {
      process.stderr.write("  At least one channel ID is required.\n");
      continue;
    }
    const invalid = ids.filter((id) => !isValidSnowflake(id));
    if (invalid.length > 0) {
      process.stderr.write(`  Invalid ID format (must be 17-20 digits): ${invalid.join(", ")}\n`);
      continue;
    }
    allowlisted_channels = ids;
    process.stderr.write(`  ✓ ${ids.length} channel${ids.length === 1 ? "" : "s"} added.\n`);
    break;
  }

  // ── 3e. User ID ───────────────────────────────────────────────────────────
  process.stderr.write("\n  Step 3e — Your Discord user ID\n");
  process.stderr.write("  ───────────────────────────────\n");
  process.stderr.write("  Right-click your own avatar in Discord → 'Copy User ID'\n\n");

  let user_id = "";
  while (true) {
    const raw = await readPlainLine("  Paste your Discord user ID: ");
    const id = raw.trim();
    if (!isValidSnowflake(id)) {
      process.stderr.write("  Invalid format (must be 17-20 digits). Try again.\n");
      continue;
    }
    user_id = id;
    process.stderr.write("  ✓ Captured.\n");
    break;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const cfg: DiscordConfig = {
    discord_bot_token,
    anthropic_api_key,
    allowlisted_channels,
    user_id,
  };

  writeDiscordConfig(cfg);
  process.stderr.write(`\n  ✓ Config saved to ${getConfigPath()} (mode 0600)\n`);

  return cfg;
}
