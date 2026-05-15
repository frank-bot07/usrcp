#!/usr/bin/env node
/**
 * USRCP Slack adapter entry point.
 *
 *   usrcp-slack                     # load config, start bot (Socket Mode)
 *   usrcp-slack --reset-config      # re-run 'usrcp setup --adapter=slack'
 *
 * Requires: USRCP_PASSPHRASE env var if the local ledger is passphrase-
 * protected. All other config lives in ~/.usrcp/slack-config.json.
 *
 * Transport: Socket Mode via @slack/bolt. No public HTTPS endpoint needed.
 * Two-token model:
 *   slack_bot_token  (xoxb-)  — messaging, channel reads
 *   slack_app_token  (xapp-)  — persistent Socket Mode WebSocket
 *
 * Trigger model:
 *   - DMs (channel_type "im") — always trigger a reply
 *   - Channels: app_mention event with event.user === cfg.user_id
 *   - Capture: user's GenericMessageEvents in allowlisted channels
 *              (subtype === undefined, skips edits / joins / bot events)
 */

import { execSync } from "node:child_process";
import { App, LogLevel } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { getUserDir } from "usrcp-local/dist/encryption.js";
import { loadConfig } from "./config.js";
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
 * Convert a Bolt GenericMessageEvent to our narrow CaptureMessage shape.
 * Isolated here so capture.ts / reader.ts have no Bolt compile-time dep.
 */
function toCaptureMessage(event: GenericMessageEvent, channelName?: string): CaptureMessage {
  return {
    id: event.ts,
    content: event.text ?? "",
    author: {
      id: event.user,
      // GenericMessageEvent has no bot flag by design (subtype: undefined).
      // bot_id is present when the event is attributed to a bot via workflow;
      // treat that as a bot message so capture skips it.
      bot: typeof event.bot_id === "string" && event.bot_id.length > 0,
    },
    channel: { id: event.channel, name: channelName },
    thread: event.thread_ts ? { id: event.thread_ts } : null,
    team_id: event.team,
    // Slack's ts is "seconds.microseconds" as a string; * 1000 -> ms.
    ts_ms: Math.floor(Number(event.ts) * 1000),
  };
}

async function main() {
  // --reset-config delegates to the unified wizard instead of prompting inline.
  if (hasFlag("reset-config")) {
    console.error("[usrcp-slack] --reset-config: launching 'usrcp setup --adapter=slack'...");
    try {
      execSync("usrcp setup --adapter=slack", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  const config = loadConfig();

  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const llm = new AnthropicLlm({ apiKey: config.anthropic_api_key });

  const mode = resolveMode(getArg("mode"), streamInstalled());
  console.error(
    `[usrcp-slack] capture mode: ${mode}` +
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

  const app = new App({
    token: config.slack_bot_token,
    appToken: config.slack_app_token,
    socketMode: true,
    // Suppress Bolt's own logger to keep stderr clean
    logLevel: LogLevel.ERROR,
  });

  // ── Capture: user messages in allowlisted channels ─────────────────────────
  // Bolt's message listener receives AllMessageEvents. We narrow to
  // GenericMessageEvent (subtype === undefined) to skip system messages,
  // edits, joins, bot messages, etc. The check happens at the listener boundary.
  app.message(async ({ message, client }) => {
    // Narrow to user message: subtype must be undefined (GenericMessageEvent).
    if (message.subtype !== undefined) return;
    const gme = message as GenericMessageEvent;

    // Skip bot-attributed events even within GenericMessageEvent.
    if (typeof gme.bot_id === "string" && gme.bot_id.length > 0) return;

    // Note: we used to early-return on channel_type === "im" to "let
    // the DM listener handle it," but that DM listener only does
    // reply, not capture. The result was that DMs added to
    // allowlisted_channels were silently never captured anywhere
    // (Codex round-1 P1 against #42). The reply listener below is
    // still its own app.message handler; both fire for the same
    // message but do different work.

    // Skip channels outside the allowlist (both ledger and stream paths
    // respect the same channel allowlist).
    if (!config.allowlisted_channels.includes(gme.channel)) return;

    // Resolve channel name for tags (best-effort; don't block on failure).
    let channelName: string | undefined;
    try {
      const info = await client.conversations.info({ channel: gme.channel });
      channelName = (info.channel as { name?: string } | undefined)?.name;
    } catch {
      // ignore - name is cosmetic
    }

    const cm = toCaptureMessage(gme, channelName);

    // Ledger path: user-only filter (existing behavior).
    if (
      (mode === "ledger" || mode === "both") &&
      gme.user === config.user_id
    ) {
      try {
        const captureOutcome = await captureMessage(ledger, cm, config, llm);
        if (captureOutcome.captured) {
          console.error(
            `[usrcp-slack] ledger captured ts=${cm.id} channel=${cm.channel.id} ` +
              `→ event ${captureOutcome.event_id} (seq ${captureOutcome.ledger_sequence}` +
              `${captureOutcome.duplicate ? ", duplicate" : ""})`
          );
        }
      } catch (err) {
        console.error("[usrcp-slack] capture error:", err instanceof Error ? err.message : err);
      }
    }

    // Stream path: both sides on allowlisted channels (bot already filtered above).
    if (streamClient && (mode === "stream" || mode === "both")) {
      try {
        const streamOutcome = await captureMessageToStream(
          streamClient as Parameters<typeof captureMessageToStream>[0],
          cm,
          config
        );
        if (streamOutcome.captured) {
          console.error(
            `[usrcp-slack] stream captured ts=${cm.id} (${streamOutcome.side}) ` +
              `→ event ${streamOutcome.event_uuid}` +
              (streamOutcome.thread_id ? ` (thread ${streamOutcome.thread_id})` : "")
          );
        }
      } catch (err) {
        console.error("[usrcp-slack] stream error:", err instanceof Error ? err.message : err);
      }
    }
  });

  // ── Reply: app_mention ─────────────────────────────────────────────────────
  app.event("app_mention", async ({ event, say }) => {
    // Only respond to our user's mentions; ignore mentions from others.
    if (event.user !== config.user_id) return;

    const cm: CaptureMessage = {
      id: event.ts,
      content: event.text,
      author: { id: event.user, bot: false },
      channel: { id: event.channel },
      thread: event.thread_ts ? { id: event.thread_ts } : null,
      team_id: event.team,
      ts_ms: Math.floor(Number(event.ts) * 1000),
    };

    try {
      const replyOutcome = await composeAndReply(
        ledger,
        cm,
        config,
        llm,
        async (text) => {
          await say({
            text,
            // Reply in-thread so the bot's response stays in context.
            thread_ts: event.thread_ts ?? event.ts,
          });
        }
      );
      if (replyOutcome.replied) {
        console.error(`[usrcp-slack] replied to mention in channel ${event.channel} (${replyOutcome.replyText.length} chars)`);
      } else {
        console.error(`[usrcp-slack] declined to reply in channel ${event.channel}: ${replyOutcome.reason}`);
      }
    } catch (err) {
      console.error("[usrcp-slack] mention reply error:", err instanceof Error ? err.message : err);
    }
  });

  // ── Reply: DM (channel_type "im") ─────────────────────────────────────────
  // DMs to the bot always trigger a reply regardless of allowlist.
  app.message(async ({ message, say }) => {
    if (message.subtype !== undefined) return;
    const gme = message as GenericMessageEvent;

    if (gme.channel_type !== "im") return;
    if (gme.user !== config.user_id) return;

    const cm: CaptureMessage = {
      id: gme.ts,
      content: gme.text ?? "",
      author: { id: gme.user, bot: false },
      channel: { id: gme.channel },
      thread: gme.thread_ts ? { id: gme.thread_ts } : null,
      team_id: gme.team,
      ts_ms: Math.floor(Number(gme.ts) * 1000),
    };

    // For DMs, temporarily add the DM channel to the allowlist for the reply check.
    const configWithDm = {
      ...config,
      allowlisted_channels: [...config.allowlisted_channels, gme.channel],
    };

    try {
      const replyOutcome = await composeAndReply(
        ledger,
        cm,
        configWithDm,
        llm,
        async (text) => {
          await say({ text });
        }
      );
      if (replyOutcome.replied) {
        console.error(`[usrcp-slack] replied to DM in channel ${gme.channel} (${replyOutcome.replyText.length} chars)`);
      } else {
        console.error(`[usrcp-slack] declined to reply to DM in channel ${gme.channel}: ${replyOutcome.reason}`);
      }
    } catch (err) {
      console.error("[usrcp-slack] DM reply error:", err instanceof Error ? err.message : err);
    }
  });

  const shutdown = async (signal: string) => {
    console.error(`[usrcp-slack] ${signal} received, shutting down.`);
    try { await app.stop(); } catch { /* ignore */ }
    try { streamClient?.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  await app.start();
  console.error("[usrcp-slack] Connected via Socket Mode");
  console.error(`[usrcp-slack] Listening on channels: ${config.allowlisted_channels.join(", ")}`);
  console.error(`[usrcp-slack] Capturing messages from user: ${config.user_id}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[usrcp-slack] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
