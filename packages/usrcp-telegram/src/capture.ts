/**
 * Capture pipeline: a Telegram message → a USRCP timeline event.
 *
 * Exported as a pure function taking a Ledger + a narrow message shape
 * + a config + an LLM client. The grammY Context type is not imported
 * here; the entry point (index.ts) maps from grammY to CaptureMessage
 * before calling this function.
 *
 * Filtering rules (v0, single-user vision-proof):
 *   - Ignore bot messages (msg.author.bot === true)
 *   - Ignore messages from other humans — only capture the configured
 *     user's own messages
 *   - Ignore messages in chats not on the allowlist
 *   - Ignore empty messages (e.g., photo-only without caption)
 */

import type { LlmClient } from "./llm.js";
import type { TelegramConfig } from "./config.js";

/**
 * Minimal Telegram message shape we depend on. Keeping this local (rather
 * than importing from grammy) makes the capture logic trivially testable
 * with plain objects and avoids a compile-time dep on the grammy runtime.
 *
 * Field mapping from grammY Context:
 *   id              <- String(ctx.message.message_id)
 *   content         <- ctx.message.text
 *   author.id       <- String(ctx.from!.id)
 *   author.bot      <- ctx.from!.is_bot
 *   channel.id      <- String(ctx.chat.id)   (negative for groups)
 *   channel.name    <- ctx.chat.title (groups) or ctx.chat.username (private)
 *   thread          <- ctx.message.message_thread_id (forum/topic threads)
 */
export interface CaptureMessage {
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  channel: { id: string; name?: string };
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
  config: TelegramConfig,
  llm: LlmClient,
  opts: { intent?: string } = {}
): Promise<CaptureOutcome> {
  if (msg.author.bot) return { captured: false, reason: "bot_author" };
  if (msg.author.id !== config.user_id) return { captured: false, reason: "other_user" };
  if (!config.allowlisted_chats.includes(msg.channel.id)) {
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

  const result = ledger.appendEvent(
    {
      domain: "telegram",
      summary,
      intent: opts.intent ?? "user_message",
      outcome: "success",
      detail: {
        chat_id: msg.channel.id,
        chat_name: msg.channel.name ?? null,
        message_id: msg.id,
        raw_content: msg.content,
      },
      tags: ["chat", channelTag],
      channel_id: msg.channel.id,
      thread_id: msg.thread?.id,
      external_user_id: msg.author.id,
    },
    "telegram",
    // Idempotency key is chat-id qualified because Telegram message_ids are
    // per-chat (not global), unlike Discord's global message IDs.
    `telegram:${msg.channel.id}:${msg.id}`,
    "telegram-bot"
  );

  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
