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

import { execSync } from "node:child_process";
import { Client, GatewayIntentBits, Events, type Message } from "discord.js";
import { Ledger } from "usrcp-core/ledger";
import { getUserDir } from "usrcp-core/encryption";
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

// Per-message capture lines, login/listening banners, and other status
// chatter are gated behind USRCP_VERBOSE=1 so a quiet run (and a demo
// recording) only show real errors on stderr.
const VERBOSE = process.env.USRCP_VERBOSE === "1";
const info = (...args: unknown[]): void => {
  if (VERBOSE) console.error(...args);
};

export type CaptureMode = "ledger" | "stream" | "both";

/**
 * Detect whether usrcp-stream is resolvable from this package. The Phase 6
 * default is `--mode=both` when it is, `--mode=ledger` when it isn't.
 * The check is `require.resolve` only (no actual load), so a fresh
 * checkout without stream installed remains a zero-cost ledger-only run.
 */
export function streamInstalled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve("usrcp-stream/dist/capture-client.js");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective capture mode. Explicit `--mode=X` wins; otherwise
 * default to `both` if stream is installed, `ledger` if it isn't.
 */
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
 * Convert a discord.js Message to our narrow CaptureMessage shape.
 * Isolated here so neither capture.ts nor reader.ts has to depend on
 * discord.js types.
 */
function toCaptureMessage(m: Message): CaptureMessage {
  return {
    id: m.id,
    content: m.content,
    author: {
      id: m.author.id,
      bot: m.author.bot,
      displayName: m.author.globalName ?? m.author.username,
    },
    channel: {
      id: m.channelId,
      // Text channels have .name; DMs/threads may not.
      name: "name" in m.channel && typeof m.channel.name === "string" ? m.channel.name : undefined,
    },
    guild: m.guild ? { id: m.guild.id, name: m.guild.name } : null,
    // thread on a Message is either a ThreadChannel or null
    thread: m.thread ? { id: m.thread.id } : null,
    ts_ms: m.createdTimestamp,
  };
}

async function main() {
  // --reset-config delegates to the unified wizard instead of prompting inline.
  if (hasFlag("reset-config")) {
    console.error("[usrcp-discord] --reset-config: launching 'usrcp setup --adapter=discord'...");
    try {
      execSync("usrcp setup --adapter=discord", { stdio: "inherit" });
    } catch {
      // execSync throws on non-zero exit; the wizard already printed the error.
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
  info(
    `[usrcp-discord] capture mode: ${mode}` +
      (mode === "both"
        ? " (ledger keeps user-only filter; stream captures all humans)"
        : "")
  );

  // Construct the stream client only when the mode requires it. Lazy
  // require dodges the import when --mode=ledger so users without
  // usrcp-stream installed see no module-load failure.
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

  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  discordClient.once(Events.ClientReady, (c) => {
    info(`[usrcp-discord] Logged in as ${c.user.tag}`);
    info(`[usrcp-discord] Listening on channels: ${config.allowlisted_channels.join(", ")}`);
    info(`[usrcp-discord] Capturing messages from user: ${config.user_id}`);
  });

  discordClient.on(Events.MessageCreate, async (msg) => {
    try {
      const cm = toCaptureMessage(msg);

      // Ledger path (existing behavior, user-only filtered).
      if (mode === "ledger" || mode === "both") {
        const captureOutcome = await captureMessage(ledger, cm, config, llm);
        if (captureOutcome.captured) {
          info(
            `[usrcp-discord] ledger captured message ${cm.id} in channel ${cm.channel.id} ` +
              `→ event ${captureOutcome.event_id} (seq ${captureOutcome.ledger_sequence}` +
              `${captureOutcome.duplicate ? ", duplicate" : ""})`
          );
        }
      }

      // Stream path (bidirectional: bots/empty/allowlist filters only).
      if (streamClient && (mode === "stream" || mode === "both")) {
        const streamOutcome = await captureMessageToStream(
          streamClient as Parameters<typeof captureMessageToStream>[0],
          cm,
          config
        );
        if (streamOutcome.captured) {
          info(
            `[usrcp-discord] stream captured message ${cm.id} (${streamOutcome.side}) ` +
              `→ event ${streamOutcome.event_uuid}` +
              (streamOutcome.thread_id ? ` (thread ${streamOutcome.thread_id})` : "")
          );
        }
      }

      // Reply: if the bot is @-mentioned, compose and post a context-aware reply.
      if (discordClient.user && msg.mentions.has(discordClient.user) && !msg.author.bot) {
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
          info(`[usrcp-discord] replied in channel ${cm.channel.id} (${replyOutcome.replyText.length} chars)`);
        } else {
          info(`[usrcp-discord] declined to reply in channel ${cm.channel.id}: ${replyOutcome.reason}`);
        }
      }
    } catch (err) {
      console.error("[usrcp-discord] handler error:", err instanceof Error ? err.message : err);
    }
  });

  const shutdown = async (signal: string) => {
    console.error(`[usrcp-discord] ${signal} received, shutting down.`);
    try { await discordClient.destroy(); } catch { /* ignore */ }
    try { streamClient?.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await discordClient.login(config.discord_bot_token);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[usrcp-discord] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
