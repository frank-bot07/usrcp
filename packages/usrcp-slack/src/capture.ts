/**
 * Capture pipeline: a Slack message → a USRCP timeline event.
 *
 * Exported as a pure function taking a Ledger + a narrow CaptureMessage
 * shape + a config + an LLM client. The real Bolt message types are complex
 * and platform-specific; we narrow them here and let index.ts translate
 * at the listener boundary.
 *
 * Filtering rules (v0, single-user):
 *   - Skip if author is a bot (bot_id present on the event)
 *   - Skip if message is from a different user than the configured user_id
 *   - Skip if channel is not in the allowlist
 *   - Skip if content is empty
 */

import type { LlmClient } from "./llm.js";
import type { SlackConfig } from "./config.js";

/**
 * Minimal Slack message shape we depend on. Platform-agnostic so tests
 * can pass plain objects without a Bolt runtime dependency.
 */
export interface CaptureMessage {
  /** Slack ts — unique within channel, used as idempotency key. */
  id: string;
  content: string;
  author: { id: string; bot: boolean };
  channel: { id: string; name?: string };
  thread?: { id: string } | null;
  /** team_id for cross-workspace idempotency key qualification. */
  team_id?: string;
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
  config: SlackConfig,
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
  const teamTag = msg.team_id ? `team:${msg.team_id}` : undefined;

  // Idempotency key: slack:<team_id>:<channel_id>:<ts>
  // Slack ts is unique within a channel; team_id qualifies it globally.
  const teamPart = msg.team_id ?? "unknown";
  const idempotencyKey = `slack:${teamPart}:${msg.channel.id}:${msg.id}`;

  const result = ledger.appendEvent(
    {
      domain: "communication",
      summary,
      intent: opts.intent ?? "user_message",
      outcome: "success",
      detail: {
        channel_name: msg.channel.name ?? null,
        message_ts: msg.id,
        raw_content: msg.content,
        team_id: msg.team_id ?? null,
      },
      tags: ["chat", channelTag, ...(teamTag ? [teamTag] : [])],
      channel_id: msg.channel.id,
      thread_id: msg.thread?.id,
      external_user_id: msg.author.id,
    },
    "slack",
    idempotencyKey,
    "slack-bot"
  );

  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
