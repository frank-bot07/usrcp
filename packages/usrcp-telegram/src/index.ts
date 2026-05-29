#!/usr/bin/env node
/**
 * USRCP Telegram adapter entry point.
 *
 *   usrcp-telegram                     # load config, start bot (long polling)
 *   usrcp-telegram --reset-config      # re-prompt all first-run questions
 *
 * Requires: USRCP_PASSPHRASE env var if the local ledger is passphrase-
 * protected. All other config (bot token, API key, chat allowlist, user ID)
 * lives in ~/.usrcp/telegram-config.json.
 *
 * Transport: long polling via grammY's bot.start(). No webhook needed for v0.
 *
 * Trigger model:
 *   - DMs (chat.type === "private")  — always trigger a reply
 *   - Groups/supergroups             — trigger on @username mention (text),
 *                                      text_mention entity (user.id match),
 *                                      or reply-to-bot message
 *   - Channels                       — skipped; channel posts have no .from
 *
 * Rate limits (documented; not enforced at v0 scale):
 *   ~30 msg/sec global, 1 msg/sec per chat, 20 msg/min per group.
 */

import { execSync } from "node:child_process";
import { Bot, type Context } from "grammy";
import { Ledger } from "usrcp-local/ledger";
import { getUserDir } from "usrcp-local/encryption";
import { loadConfig, preflightConfig } from "./config.js";
import { captureMessage, type CaptureMessage } from "./capture.js";
import { captureMessageToStream } from "./stream-capture.js";
import { composeAndReply } from "./reader.js";
import { AnthropicLlm } from "./llm.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getArg(name: string): string | undefined {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) {
      return args[i].split("=").slice(1).join("=");
    }
  }
  return undefined;
}

export type CaptureMode = "ledger" | "stream" | "both";

export function streamInstalled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve("usrcp-stream/dist/capture-client.js");
    return true;
  } catch {
    return false;
  }
}

export function resolveMode(
  explicit: string | undefined,
  streamPresent: boolean
): CaptureMode {
  if (explicit) {
    if (explicit !== "ledger" && explicit !== "stream" && explicit !== "both") {
      throw new Error(
        `--mode must be one of ledger|stream|both, got '${explicit}'`
      );
    }
    if (!streamPresent && (explicit === "stream" || explicit === "both")) {
      throw new Error(
        `--mode '${explicit}' requires usrcp-stream to be installed. ` +
          `Install it (npm install usrcp-stream from this package) or use --mode ledger.`
      );
    }
    return explicit;
  }
  return streamPresent ? "both" : "ledger";
}

/**
 * Convert a grammY Context (message:text filter guaranteed) to our narrow
 * CaptureMessage shape. Isolated here so capture.ts / reader.ts have no
 * grammy compile-time dependency.
 *
 * channel_id is the stringified chat ID. Telegram group/supergroup IDs are
 * negative numbers; stringify to match Discord's string storage parity.
 * message_id is per-chat (not global), so the idempotency key in capture.ts
 * is qualified as `telegram:<chat_id>:<message_id>`.
 */
function toCaptureMessage(ctx: Context): CaptureMessage {
  const msg = ctx.message!;
  const chat = ctx.chat!;
  const from = ctx.from!;

  // Derive a human-readable chat name for tags.
  let chatName: string | undefined;
  if ("title" in chat && typeof chat.title === "string") {
    chatName = chat.title;
  } else if ("username" in chat && typeof chat.username === "string") {
    chatName = chat.username;
  }

  const displayName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ") || from.username;

  return {
    id: String(msg.message_id),
    content: msg.text ?? "",
    author: { id: String(from.id), bot: from.is_bot, displayName },
    channel: { id: String(chat.id), name: chatName },
    thread: msg.message_thread_id != null ? { id: String(msg.message_thread_id) } : null,
    ts_ms: msg.date * 1000,
  };
}

/**
 * Decide whether a message should trigger a bot reply.
 *
 * Trigger conditions (checked in order):
 *   1. DM (chat.type === "private") — always reply
 *   2. @username text mention (entity type "mention", text matches bot's username)
 *   3. Clickable user mention with no username (entity type "text_mention", user.id === botInfo.id)
 *   4. The message is a reply to a message sent by the bot
 */
function shouldReply(ctx: Context, botId: number, botUsername: string): boolean {
  const msg = ctx.message!;
  const chat = ctx.chat!;

  if (chat.type === "private") return true;

  const entities = msg.entities ?? [];
  const text = msg.text ?? "";

  for (const e of entities) {
    if (e.type === "mention") {
      const mentioned = text.slice(e.offset, e.offset + e.length);
      if (mentioned === `@${botUsername}`) return true;
    }
    if (e.type === "text_mention" && e.user?.id === botId) return true;
  }

  if (msg.reply_to_message?.from?.id === botId) return true;

  return false;
}

async function main() {
  // --reset-config delegates to the unified wizard instead of prompting inline.
  if (hasFlag("reset-config")) {
    console.error("[usrcp-telegram] --reset-config: launching 'usrcp setup --adapter=telegram'...");
    try {
      execSync("usrcp setup --adapter=telegram", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  // Validate config exists + is complete BEFORE constructing the
  // Ledger. `new Ledger(...)` would silently auto-initialize a
  // dev-mode ledger if none exists yet, which would poison a
  // subsequent `usrcp setup` run (it skips the passphrase prompt
  // when a dev-mode ledger is already present).
  preflightConfig();
  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const masterKey = ledger.getMasterKey();

  const config = loadConfig(masterKey);
  const llm = new AnthropicLlm({ apiKey: config.anthropic_api_key });

  const mode = resolveMode(getArg("mode"), streamInstalled());
  console.error(
    `[usrcp-telegram] capture mode: ${mode}` +
      (mode === "both"
        ? " (ledger keeps user-only filter; stream captures all humans)"
        : "")
  );

  let streamClient: {
    capture: (event: unknown) => Promise<unknown>;
    close: () => void;
  } | null = null;
  if (mode === "stream" || mode === "both") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const streamMod = require("usrcp-stream/dist/capture-client.js") as any;
    streamClient = streamMod.createStreamCaptureClient(
      ledger.getMasterKey(),
      getUserDir(),
      { ledger }
    );
  }

  const bot = new Bot(config.telegram_bot_token);
  // Must call bot.init() before any handler accesses bot.botInfo.
  await bot.init();

  const botId = bot.botInfo.id;
  const botUsername = bot.botInfo.username;

  console.error(`[usrcp-telegram] Logged in as @${botUsername} (id=${botId})`);
  console.error(`[usrcp-telegram] Listening on ${config.allowlisted_chats.length} chats`);
  console.error(`[usrcp-telegram] Capturing from user ID: ${config.user_id}`);

  // bot.on("message:text") guarantees ctx.message.text is a non-undefined string.
  // Non-text updates (photos, stickers, etc.) are silently ignored in v0.
  bot.on("message:text", async (ctx) => {
    try {
      const cm = toCaptureMessage(ctx);

      if (mode === "ledger" || mode === "both") {
        const captureOutcome = await captureMessage(ledger, cm, config, llm);
        if (captureOutcome.captured) {
          console.error(
            `[usrcp-telegram] ledger captured message ${cm.id} in chat ${cm.channel.id} ` +
              `→ event ${captureOutcome.event_id} (seq ${captureOutcome.ledger_sequence}` +
              `${captureOutcome.duplicate ? ", duplicate" : ""})`
          );
        }
      }

      if (streamClient && (mode === "stream" || mode === "both")) {
        const streamOutcome = await captureMessageToStream(
          streamClient as Parameters<typeof captureMessageToStream>[0],
          cm,
          config
        );
        if (streamOutcome.captured) {
          console.error(
            `[usrcp-telegram] stream captured message ${cm.id} (${streamOutcome.side}) ` +
              `→ event ${streamOutcome.event_uuid}` +
              (streamOutcome.thread_id ? ` (thread ${streamOutcome.thread_id})` : "")
          );
        }
      }

      // Reply: DM, @-mention, text_mention entity, or reply-to-bot.
      if (shouldReply(ctx, botId, botUsername)) {
        const replyOutcome = await composeAndReply(
          ledger,
          cm,
          config,
          llm,
          async (text) => {
            await ctx.reply(text, {
              reply_parameters: { message_id: ctx.message!.message_id },
            });
          }
        );
        if (replyOutcome.replied) {
          console.error(`[usrcp-telegram] replied in chat ${cm.channel.id} (${replyOutcome.replyText.length} chars)`);
        } else {
          console.error(`[usrcp-telegram] declined to reply in chat ${cm.channel.id}: ${replyOutcome.reason}`);
        }
      }
    } catch (err) {
      console.error("[usrcp-telegram] handler error:", err instanceof Error ? err.message : err);
    }
  });

  const shutdown = async (signal: string) => {
    console.error(`[usrcp-telegram] ${signal} received, shutting down.`);
    try { await bot.stop(); } catch { /* ignore */ }
    try { streamClient?.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Long polling — the correct transport for v0 on a laptop or VPS.
  // Switch to webhooks later if scale demands a public HTTPS endpoint.
  await bot.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[usrcp-telegram] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
