/**
 * Interactive setup wizard for the USRCP Slack adapter.
 *
 * Called by `usrcp setup` (or `usrcp setup --adapter=slack`).
 * Walks the user through every credential with inline instructions,
 * validation against the Slack API, and proactive trap warnings.
 *
 * Exports:
 *   runSlackSetup()  — full interactive flow; writes slack-config.json
 */

import * as https from "node:https";
import { execSync } from "node:child_process";
import { getConfigPath, writeSlackConfig, type SlackConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal prompt helpers (no external dep — keeps usrcp-slack lean)
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
// Slack API helpers
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function httpsPost(
  url: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
        ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsGet(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ""),
      method: "GET",
      headers,
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface AuthTestResponse {
  ok: boolean;
  user_id?: string;
  team_id?: string;
  team?: string;
  error?: string;
}

async function validateBotToken(token: string): Promise<
  | { ok: true; user_id: string; team_id: string; team: string }
  | { ok: false; reason: string }
> {
  try {
    const { status, body } = await httpsPost(
      "https://slack.com/api/auth.test",
      { Authorization: `Bearer ${token}` }
    );
    if (status !== 200) {
      return { ok: false, reason: `HTTP ${status} from auth.test.` };
    }
    const res = JSON.parse(body) as AuthTestResponse;
    if (!res.ok) {
      return { ok: false, reason: `Slack API error: ${res.error ?? "unknown"}.` };
    }
    return {
      ok: true,
      user_id: res.user_id ?? "",
      team_id: res.team_id ?? "",
      team: res.team ?? "",
    };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface ConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

async function validateAppToken(appToken: string): Promise<
  | { ok: true }
  | { ok: false; reason: string }
> {
  try {
    const { status, body } = await httpsPost(
      "https://slack.com/api/apps.connections.open",
      { Authorization: `Bearer ${appToken}` }
    );
    if (status !== 200) {
      return { ok: false, reason: `HTTP ${status} from apps.connections.open.` };
    }
    const res = JSON.parse(body) as ConnectionsOpenResponse;
    if (!res.ok) {
      const error = res.error ?? "unknown";
      if (error === "token_expired" || error === "invalid_auth" || error.includes("not_allowed")) {
        return {
          ok: false,
          reason: `Slack API error: ${error}. Most common cause: app-level token is missing the 'connections:write' scope. Re-generate the token with that scope.`,
        };
      }
      return { ok: false, reason: `Slack API error: ${error}.` };
    }
    // res.url is the WebSocket URL — we got it, proving the token is valid.
    // We do NOT connect to the WebSocket; just confirm token validity.
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function validateAnthropicKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
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
    return { ok: true };
  }
}

interface ConversationsListResponse {
  ok: boolean;
  channels?: Array<{
    id: string;
    name?: string;
    is_member?: boolean;
    is_channel?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    user?: string;
    channel_type?: string;
  }>;
  error?: string;
}

async function listMemberChannels(botToken: string): Promise<
  | { ok: true; channels: Array<{ id: string; display: string }> }
  | { ok: false; reason: string }
> {
  try {
    const url =
      "https://slack.com/api/conversations.list" +
      "?types=public_channel,private_channel,im,mpim" +
      "&exclude_archived=true&limit=200";
    const { status, body } = await httpsGet(url, {
      Authorization: `Bearer ${botToken}`,
    });
    if (status !== 200) {
      return { ok: false, reason: `HTTP ${status} from conversations.list.` };
    }
    const res = JSON.parse(body) as ConversationsListResponse;
    if (!res.ok) {
      return { ok: false, reason: `Slack API error: ${res.error ?? "unknown"}.` };
    }
    const raw = res.channels ?? [];
    const member = raw.filter((c) => c.is_member === true);
    const channels = member.map((c) => ({
      id: c.id,
      display: c.is_im
        ? `DM (${c.user ?? c.id})`
        : `#${c.name ?? c.id} (${c.id})`,
    }));
    return { ok: true, channels };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err instanceof Error ? err.message : String(err)}` };
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

const USER_ID_RE = /^U[A-Z0-9]{8,}$/;
function isValidSlackUserId(id: string): boolean {
  return USER_ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Main wizard flow
// ---------------------------------------------------------------------------

export async function runSlackSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    const p = getConfigPath();
    console.error(
      `usrcp-slack setup: stdin is not a TTY.\n` +
      `Pre-populate ${p} with mode 0600 and re-run.`
    );
    process.exit(1);
  }

  process.stderr.write("\n");
  process.stderr.write("  ┌─ Slack adapter setup ───────────────────────────────────────┐\n");
  process.stderr.write("  │ I'll walk you through two Slack tokens and one Anthropic key. │\n");
  process.stderr.write("  │ Config saved to ~/.usrcp/slack-config.json (mode 0600)        │\n");
  process.stderr.write("  └─────────────────────────────────────────────────────────────┘\n\n");

  // ── Step 1 — Slack app creation guidance ──────────────────────────────────
  process.stderr.write("  Step 1 — Create your Slack app\n");
  process.stderr.write("  ───────────────────────────────\n");
  process.stderr.write("  1. Open https://api.slack.com/apps → 'Create New App' → 'From scratch'\n");
  process.stderr.write("  2. Name it (e.g., 'usrcp-dev'), pick your workspace.\n\n");
  process.stderr.write("  In the app config:\n");
  process.stderr.write("  3. OAuth & Permissions → Add bot scopes:\n");
  process.stderr.write("       app_mentions:read  channels:history  chat:write\n");
  process.stderr.write("       groups:history     im:history        mpim:history\n");
  process.stderr.write("       users:read         channels:read     groups:read\n");
  process.stderr.write("       im:read            mpim:read\n\n");
  process.stderr.write("  4. Socket Mode → Enable it.\n");
  process.stderr.write("       Generate an App-Level Token with scope 'connections:write'.\n");
  process.stderr.write("       Copy it — it starts with 'xapp-'.\n\n");
  process.stderr.write("  5. Event Subscriptions → Enable. Subscribe to bot events:\n");
  process.stderr.write("       message.channels  message.groups  message.im\n");
  process.stderr.write("       message.mpim      app_mention\n\n");
  process.stderr.write("  6. Install to Workspace → click and approve.\n");
  process.stderr.write("       Copy the Bot User OAuth Token (starts with 'xoxb-').\n\n");

  const autoOpen = await readYN("  Auto-open https://api.slack.com/apps now?");
  if (autoOpen) tryOpenUrl("https://api.slack.com/apps");

  await readYN("  Done creating the app and collecting both tokens?", true);

  // ── Step 2 — Bot token (xoxb-) ────────────────────────────────────────────
  process.stderr.write("\n  Step 2 — Bot token (xoxb-)\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  From: Slack app config → Install App → Bot User OAuth Token\n\n");

  let slack_bot_token = "";
  let bot_user_id = "";
  let team_id = "";
  let team = "";

  while (true) {
    slack_bot_token = await readMaskedLine("  Paste your bot token (xoxb-...): ");
    if (!slack_bot_token.trim()) {
      process.stderr.write("  Token cannot be empty. Try again.\n");
      continue;
    }
    if (!slack_bot_token.startsWith("xoxb-")) {
      process.stderr.write("  Bot token must start with 'xoxb-'. Try again.\n");
      continue;
    }
    process.stderr.write("  Validating via auth.test...\n");
    const result = await validateBotToken(slack_bot_token);
    if (!result.ok) {
      process.stderr.write(`  ${result.reason} Try again.\n`);
      continue;
    }
    bot_user_id = result.user_id;
    team_id = result.team_id;
    team = result.team;
    process.stderr.write(`  ✓ Token valid. Workspace: ${team} (${team_id})\n`);
    break;
  }

  // ── Step 3 — App-level token (xapp-) ─────────────────────────────────────
  process.stderr.write("\n  Step 3 — App-level token (xapp-)\n");
  process.stderr.write("  ──────────────────────────────────\n");
  process.stderr.write("  From: Slack app config → Basic Information → App-Level Tokens\n");
  process.stderr.write("  (The token you generated with 'connections:write' scope.)\n\n");

  let slack_app_token = "";

  while (true) {
    slack_app_token = await readMaskedLine("  Paste your app-level token (xapp-...): ");
    if (!slack_app_token.trim()) {
      process.stderr.write("  Token cannot be empty. Try again.\n");
      continue;
    }
    if (!slack_app_token.startsWith("xapp-")) {
      process.stderr.write("  App-level token must start with 'xapp-'. Try again.\n");
      continue;
    }
    process.stderr.write("  Validating via apps.connections.open...\n");
    const result = await validateAppToken(slack_app_token);
    if (!result.ok) {
      process.stderr.write(`  ${result.reason}\n`);
      process.stderr.write("  Try again.\n");
      continue;
    }
    process.stderr.write("  ✓ App-level token valid (connections:write confirmed).\n");
    break;
  }

  // ── Step 4 — Anthropic API key ────────────────────────────────────────────
  process.stderr.write("\n  Step 4 — Anthropic API key\n");
  process.stderr.write("  ───────────────────────────\n");
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

  // ── Step 5 — Channel allowlist ────────────────────────────────────────────
  process.stderr.write("\n  Step 5 — Channel allowlist\n");
  process.stderr.write("  ───────────────────────────\n");
  process.stderr.write("  Fetching channels the bot is a member of...\n");

  let allowlisted_channels: string[] = [];

  const channelListResult = await listMemberChannels(slack_bot_token);
  if (!channelListResult.ok) {
    process.stderr.write(`  Warning: could not fetch channel list: ${channelListResult.reason}\n`);
    process.stderr.write("  You can paste channel IDs manually instead.\n");

    while (true) {
      const raw = await readPlainLine(
        "  Paste channel IDs (comma-separated, e.g. C01234567,C89012345):\n  > "
      );
      const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
      if (ids.length === 0) {
        process.stderr.write("  At least one channel ID is required.\n");
        continue;
      }
      allowlisted_channels = ids;
      process.stderr.write(`  ✓ ${ids.length} channel${ids.length === 1 ? "" : "s"} added.\n`);
      break;
    }
  } else {
    const { channels } = channelListResult;
    if (channels.length === 0) {
      process.stderr.write("  No channels found where the bot is a member.\n");
      process.stderr.write("  Invite the bot to at least one channel, then re-run setup.\n");
      process.exit(1);
    }

    process.stderr.write(`  Found ${channels.length} channel${channels.length === 1 ? "" : "s"}:\n\n`);
    for (let i = 0; i < channels.length; i++) {
      process.stderr.write(`    [${i + 1}] ${channels[i].display}\n`);
    }
    process.stderr.write("\n");

    while (true) {
      const raw = await readPlainLine(
        "  Enter numbers to allowlist (comma-separated, e.g. 1,3,5) or 'all':\n  > "
      );
      const trimmed = raw.trim();
      if (trimmed.toLowerCase() === "all") {
        allowlisted_channels = channels.map((c) => c.id);
        process.stderr.write(`  ✓ All ${channels.length} channels added.\n`);
        break;
      }
      const nums = trimmed
        .split(/[,\s]+/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 1 && n <= channels.length);
      if (nums.length === 0) {
        process.stderr.write(`  Enter numbers between 1 and ${channels.length}, or 'all'. Try again.\n`);
        continue;
      }
      allowlisted_channels = nums.map((n) => channels[n - 1].id);
      process.stderr.write(`  ✓ ${allowlisted_channels.length} channel${allowlisted_channels.length === 1 ? "" : "s"} added.\n`);
      break;
    }
  }

  // ── Step 6 — User ID ──────────────────────────────────────────────────────
  process.stderr.write("\n  Step 6 — Your Slack user ID\n");
  process.stderr.write("  ────────────────────────────\n");
  process.stderr.write("  This is YOUR user ID (not the bot's). Only messages from this\n");
  process.stderr.write("  user will be captured.\n\n");
  process.stderr.write("  To find it in Slack:\n");
  process.stderr.write("    Click your own avatar → 'View profile' → '...' menu → 'Copy member ID'\n\n");

  // Show bot_user_id as a hint (it's NOT what we want, but worth labeling)
  process.stderr.write(`  (Bot's user ID for reference: ${bot_user_id} — do NOT paste this)\n\n`);

  let user_id = "";
  while (true) {
    const raw = await readPlainLine("  Paste YOUR Slack user ID (starts with U): ");
    const id = raw.trim();
    if (!isValidSlackUserId(id)) {
      process.stderr.write("  Invalid format (must start with U followed by 8+ uppercase alphanumeric chars). Try again.\n");
      continue;
    }
    if (id === bot_user_id) {
      process.stderr.write("  That's the bot's user ID, not yours. Enter YOUR member ID. Try again.\n");
      continue;
    }
    user_id = id;
    process.stderr.write(`  ✓ User ID: ${user_id}\n`);
    break;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const cfg: SlackConfig = {
    slack_bot_token,
    slack_app_token,
    anthropic_api_key,
    allowlisted_channels,
    user_id,
  };

  writeSlackConfig(cfg);
  process.stderr.write(`\n  ✓ Slack adapter configured. Config saved to ${getConfigPath()} (mode 0600)\n`);
}
