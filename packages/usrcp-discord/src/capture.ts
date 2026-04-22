/**
 * Capture pipeline: a Discord message → a USRCP timeline event.
 *
 * Exported as a pure function taking a Ledger + a duck-typed message
 * shape + a config + an LLM client. The real discord.js Message type is
 * a beast; we only need ~7 fields, so we narrow them here and let the
 * entry point in src/index.ts pass `msg` through directly.
 *
 * Filtering rules (v0, single-user vision-proof):
 *   - Ignore bot messages (msg.author.bot === true)
 *   - Ignore messages from other humans — only capture the configured
 *     user's own messages
 *   - Ignore messages in channels not on the allowlist
 */

import type { LlmClient } from "./llm.js";
import type { DiscordConfig } from "./config.js";

// Minimal Discord message shape we depend on. Keeping this local (rather
// than importing from discord.js) makes the capture logic trivially
// testable with plain objects and avoids a compile-time dep ordering
// between tests and the discord.js runtime.
export interface CaptureMessage {
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  channel: { id: string; name?: string };
  guild?: { id: string; name?: string } | null;
  thread?: { id: string } | null;
}

// Subset of Ledger we need. Duck-typed so tests can pass a fresh Ledger
// from the built usrcp-local package without a full dependency graph.
export interface CaptureLedger {
  appendEvent(
    event: {
      domain: string;
      summary: string;
      intent: string;
      outcome: "success" | "partial" | "failed" | "abandoned";
      detail?: Record<string, unknown>;
      tags?: string[];
      channel_id?: string;
      thread_id?: string;
      external_user_id?: string;
    },
    platform: string,
    idempotencyKey?: string,
    agentId?: string
  ): { event_id: string; timestamp: string; ledger_sequence: number; duplicate?: boolean };
}

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "bot_author" | "other_user" | "channel_not_allowlisted" | "empty_content";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

// Summaries over this length get compressed via the LLM; shorter messages
// use the raw text as the summary. Keeps capture cheap for one-liners.
const SUMMARIZE_THRESHOLD_CHARS = 200;

export async function captureMessage(
  ledger: CaptureLedger,
  msg: CaptureMessage,
  config: DiscordConfig,
  llm: LlmClient,
  opts: { intent?: string } = {}
): Promise<CaptureOutcome> {
  if (msg.author.bot) return { captured: false, reason: "bot_author" };
  if (msg.author.id !== config.user_id) return { captured: false, reason: "other_user" };
  if (!config.allowlisted_channels.includes(msg.channel.id)) {
    return { captured: false, reason: "channel_not_allowlisted" };
  }
  if (!msg.content || msg.content.trim().length === 0) {
    return { captured: false, reason: "empty_content" };
  }

  const summary =
    msg.content.length < SUMMARIZE_THRESHOLD_CHARS
      ? msg.content
      : await llm.summarize(msg.content);

  const channelTag = msg.channel.name ? `channel:${msg.channel.name}` : `channel:${msg.channel.id}`;
  const guildTag = msg.guild?.name ? `guild:${msg.guild.name}` : undefined;

  const result = ledger.appendEvent(
    {
      domain: "communication",
      summary,
      intent: opts.intent ?? "user_message",
      outcome: "success",
      detail: {
        guild_id: msg.guild?.id ?? null,
        guild_name: msg.guild?.name ?? null,
        channel_name: msg.channel.name ?? null,
        message_id: msg.id,
        raw_content: msg.content,
      },
      tags: ["chat", channelTag, ...(guildTag ? [guildTag] : [])],
      channel_id: msg.channel.id,
      thread_id: msg.thread?.id,
      external_user_id: msg.author.id,
    },
    "discord",
    // Use Discord's message ID as the idempotency key so a replay of
    // the same message (gateway reconnect, duplicate event) is a no-op.
    `discord:${msg.id}`,
    "discord-bot"
  );

  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
