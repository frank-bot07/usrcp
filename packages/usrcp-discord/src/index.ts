#!/usr/bin/env node
/**
 * USRCP Discord adapter entry point.
 *
 *   usrcp-discord                     # load config, start bot
 *   usrcp-discord --reset-config      # re-prompt all first-run questions
 *
 * Requires: USRCP_PASSPHRASE env var if the local ledger is passphrase-
 * protected. All other config (bot token, API key, channel allowlist,
 * user ID) lives in ~/.usrcp/discord-config.json.
 */

import { Client, GatewayIntentBits, Events, type Message } from "discord.js";
import { Ledger } from "usrcp-local/dist/ledger.js";
import { loadOrInitConfig } from "./config.js";
import { captureMessage, type CaptureMessage } from "./capture.js";
import { composeAndReply } from "./reader.js";
import { AnthropicLlm } from "./llm.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Convert a discord.js Message to our narrow CaptureMessage shape.
 * Isolated here so neither capture.ts nor reader.ts has to depend on
 * discord.js types.
 */
function toCaptureMessage(m: Message): CaptureMessage {
  return {
    id: m.id,
    content: m.content,
    author: { id: m.author.id, bot: m.author.bot },
    channel: {
      id: m.channelId,
      // Text channels have .name; DMs/threads may not.
      name: "name" in m.channel && typeof m.channel.name === "string" ? m.channel.name : undefined,
    },
    guild: m.guild ? { id: m.guild.id, name: m.guild.name } : null,
    // thread on a Message is either a ThreadChannel or null
    thread: m.thread ? { id: m.thread.id } : null,
  };
}

async function main() {
  const config = await loadOrInitConfig({ reset: hasFlag("reset-config") });

  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const llm = new AnthropicLlm({ apiKey: config.anthropic_api_key });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.error(`[usrcp-discord] Logged in as ${c.user.tag}`);
    console.error(`[usrcp-discord] Listening on channels: ${config.allowlisted_channels.join(", ")}`);
    console.error(`[usrcp-discord] Capturing messages from user: ${config.user_id}`);
  });

  client.on(Events.MessageCreate, async (msg) => {
    try {
      const cm = toCaptureMessage(msg);

      // Capture: record the user's own message if it matches the filter.
      const captureOutcome = await captureMessage(ledger, cm, config, llm);
      if (captureOutcome.captured) {
        console.error(
          `[usrcp-discord] captured message ${cm.id} in channel ${cm.channel.id} ` +
          `→ event ${captureOutcome.event_id} (seq ${captureOutcome.ledger_sequence}` +
          `${captureOutcome.duplicate ? ", duplicate" : ""})`
        );
      }

      // Reply: if the bot is @-mentioned, compose and post a context-aware reply.
      if (client.user && msg.mentions.has(client.user) && !msg.author.bot) {
        const replyOutcome = await composeAndReply(
          ledger,
          cm,
          config,
          llm,
          async (text) => {
            await msg.reply(text);
          }
        );
        if (replyOutcome.replied) {
          console.error(`[usrcp-discord] replied in channel ${cm.channel.id} (${replyOutcome.replyText.length} chars)`);
        } else {
          console.error(`[usrcp-discord] declined to reply in channel ${cm.channel.id}: ${replyOutcome.reason}`);
        }
      }
    } catch (err) {
      console.error("[usrcp-discord] handler error:", err instanceof Error ? err.message : err);
    }
  });

  const shutdown = async (signal: string) => {
    console.error(`[usrcp-discord] ${signal} received, shutting down.`);
    try { await client.destroy(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await client.login(config.discord_bot_token);
}

main().catch((err) => {
  console.error("[usrcp-discord] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
