/**
 * Reader pipeline: incoming iMessage in an allowlisted chat → bot reply.
 *
 * Trigger model:
 *   - DM (chat.isGroup === false): always trigger
 *   - Group (chat.isGroup === true): only on configured prefix
 *
 * buildSystemPrompt is exported separately from composeAndReply so tests
 * can verify the prompt contains cross-channel context without paying for
 * an actual LLM call.
 */

import type { LlmClient } from "./llm.js";
import type { ImessageConfig } from "./config.js";
import type { CaptureMessage, CaptureLedger } from "./capture.js";

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
  chatId: string
): string {
  const identity = ledger.getIdentity();
  const prefs = ledger.getPreferences();
  const global = ledger.getTimeline({ last_n: GLOBAL_TIMELINE_LAST_N });
  const channel = ledger.getRecentEventsByChannel(chatId, CHANNEL_TIMELINE_LAST_N);

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
    `You are an agent helping ${displayName} via iMessage. Be concise.`,
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
    `Recent activity in THIS iMessage chat (last ${CHANNEL_TIMELINE_LAST_N}):`,
    channelLines || "  (no prior messages in this chat)",
    "",
    "When the user asks about what they were just doing or working on,",
    "reference specific items from the activity above. Keep replies tight",
    "(iMessage messages, not essays). Do not invent facts not present in",
    "the activity log.",
  ].join("\n");
}

export async function composeAndReply(
  ledger: ReaderLedger,
  msg: CaptureMessage,
  config: ImessageConfig,
  llm: LlmClient,
  sendReply: (text: string) => Promise<void>
): Promise<{ replied: true; replyText: string } | { replied: false; reason: string }> {
  // Outgoing (is_from_me) messages don't trigger replies
  if (msg.author.isUser) return { replied: false, reason: "is_from_me" };
  if (!config.allowlisted_chats.includes(msg.chat.id)) {
    return { replied: false, reason: "chat_not_allowlisted" };
  }

  // Determine trigger: DMs always trigger; groups only on prefix
  const isDm = !msg.chat.isGroup;
  const startsWithPrefix = msg.content.startsWith(config.prefix);
  if (!isDm && !startsWithPrefix) {
    return { replied: false, reason: "no_prefix" };
  }

  // Strip prefix before passing to LLM (it's a trigger token, not user intent)
  const userContent = startsWithPrefix
    ? msg.content.slice(config.prefix.length).trim()
    : msg.content;

  const systemPrompt = buildSystemPrompt(ledger, msg.chat.id);
  const replyText = await llm.reply(systemPrompt, userContent);

  await sendReply(replyText);

  // Record the bot's own reply in the ledger for continuity across turns.
  ledger.appendEvent(
    {
      domain: "communication",
      summary: replyText.length < 200 ? replyText : replyText.slice(0, 197) + "...",
      intent: "agent_reply",
      outcome: "success",
      detail: {
        responding_to_guid: msg.id,
        chat_guid: msg.chat.guid,
        raw_content: replyText,
      },
      tags: ["chat", "imessage", "agent_reply"],
      channel_id: msg.chat.id,
      external_user_id: msg.author.id,
    },
    "imessage",
    `imessage-reply:${msg.chat.guid}:${msg.id}`,
    "imessage-watcher"
  );

  return { replied: true, replyText };
}
