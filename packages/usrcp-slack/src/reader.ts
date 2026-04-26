/**
 * Reader pipeline: user mentions the bot or sends a DM → bot replies with
 * context drawn from the user's USRCP ledger (cross-channel + channel-local).
 *
 * buildSystemPrompt is exported separately from composeAndReply so tests
 * can verify the prompt contains the cross-channel context without
 * paying for an actual LLM call.
 */

import type { LlmClient } from "./llm.js";
import type { SlackConfig } from "./config.js";
import type { CaptureMessage, CaptureLedger } from "./capture.js";

// Reader needs read access + the same append path (to record the bot's
// own reply back into the timeline for continuity across turns).
export interface ReaderLedger extends CaptureLedger {
  getIdentity(): {
    display_name: string;
    roles: string[];
    expertise_domains: Array<{ domain: string; level: string }>;
    communication_style: string;
  };
  getPreferences(): {
    language: string;
    timezone: string;
    output_format: string;
    verbosity: string;
    custom: Record<string, unknown>;
  };
  getTimeline(options?: { last_n?: number }): Array<{
    event_id: string;
    timestamp: string;
    platform: string;
    domain: string;
    summary: string;
    intent?: string;
    channel_id?: string;
  }>;
  getRecentEventsByChannel(
    channelId: string,
    limit?: number
  ): Array<{
    event_id: string;
    timestamp: string;
    summary: string;
    intent?: string;
    channel_id?: string;
  }>;
}

const GLOBAL_TIMELINE_LAST_N = 20;
const CHANNEL_TIMELINE_LAST_N = 10;

export function buildSystemPrompt(
  ledger: ReaderLedger,
  channelId: string
): string {
  const identity = ledger.getIdentity();
  const prefs = ledger.getPreferences();
  const global = ledger.getTimeline({ last_n: GLOBAL_TIMELINE_LAST_N });
  const channel = ledger.getRecentEventsByChannel(channelId, CHANNEL_TIMELINE_LAST_N);

  const globalLines = global
    .slice()
    .reverse() // oldest first, most recent last — matches chat chronology
    .map((e) => `  - [${e.timestamp}] (${e.platform}/${e.domain}) ${e.summary}`)
    .join("\n");

  const channelLines = channel
    .slice()
    .reverse()
    .map((e) => `  - [${e.timestamp}] ${e.summary}${e.intent ? ` (${e.intent})` : ""}`)
    .join("\n");

  const displayName = identity.display_name || "the user";
  const expertise = identity.expertise_domains
    .map((e) => `${e.domain}:${e.level}`)
    .join(", ");

  return [
    `You are an agent helping ${displayName} via Slack. Be concise.`,
    "",
    "User profile:",
    `  display_name: ${identity.display_name}`,
    `  roles: ${identity.roles.join(", ") || "(none)"}`,
    `  expertise: ${expertise || "(none)"}`,
    `  communication_style: ${identity.communication_style}`,
    `  timezone: ${prefs.timezone}`,
    `  verbosity: ${prefs.verbosity}`,
    "",
    `Recent activity across all platforms (oldest → newest, last ${GLOBAL_TIMELINE_LAST_N}):`,
    globalLines || "  (no recent events)",
    "",
    `Recent activity in THIS Slack channel (last ${CHANNEL_TIMELINE_LAST_N}):`,
    channelLines || "  (no prior messages in this channel)",
    "",
    "When the user asks about what they were just doing or working on,",
    "reference specific items from the activity above. Keep replies tight",
    "(Slack messages, not essays). Do not invent facts not present in",
    "the activity log.",
  ].join("\n");
}

export async function composeAndReply(
  ledger: ReaderLedger,
  msg: CaptureMessage,
  config: SlackConfig,
  llm: LlmClient,
  sendReply: (text: string) => Promise<void>
): Promise<{ replied: true; replyText: string } | { replied: false; reason: string }> {
  if (msg.author.bot) return { replied: false, reason: "bot_author" };
  // For DMs (channel_type im), bypass the allowlist check — the DM itself
  // is the authorisation signal. For channel replies, enforce the allowlist.
  if (!config.allowlisted_channels.includes(msg.channel.id)) {
    return { replied: false, reason: "channel_not_allowlisted" };
  }

  const systemPrompt = buildSystemPrompt(ledger, msg.channel.id);
  const replyText = await llm.reply(systemPrompt, msg.content);

  await sendReply(replyText);

  // Record the bot's own reply in the ledger so the next turn has
  // continuity — otherwise the agent can't see what it just said.
  const teamPart = msg.team_id ?? "unknown";
  ledger.appendEvent(
    {
      domain: "communication",
      summary: replyText.length < 200 ? replyText : replyText.slice(0, 197) + "...",
      intent: "agent_reply",
      outcome: "success",
      detail: {
        responding_to_ts: msg.id,
        raw_content: replyText,
        team_id: msg.team_id ?? null,
      },
      tags: ["chat", "agent_reply", `channel:${msg.channel.name ?? msg.channel.id}`],
      channel_id: msg.channel.id,
      thread_id: msg.thread?.id,
      external_user_id: msg.author.id,
    },
    "slack",
    `slack-reply:${teamPart}:${msg.channel.id}:${msg.id}`,
    "slack-bot"
  );

  return { replied: true, replyText };
}
