/**
 * Capture pipeline: an iMessage event → a USRCP timeline event.
 *
 * Only user-sent messages (is_from_me=1) in allowlisted chats are captured.
 * Reactions/tapbacks are filtered upstream in index.ts before reaching here.
 *
 * Filtering rules (v0, single-user):
 *   - Skip if NOT from the user (author.isUser === false)
 *   - Skip if chat not in allowlist
 *   - Skip if content is empty
 */

import type { LlmClient } from "./llm.js";
import type { ImessageConfig } from "./config.js";

/**
 * Minimal iMessage event shape we depend on. Platform-agnostic so tests
 * can pass plain objects without spawning a real imsg process.
 */
export interface CaptureMessage {
  /** Message GUID — stable across imsg sessions. */
  id: string;
  content: string;
  author: {
    id: string;
    /** true if is_from_me=1 (user's own message), false for incoming. */
    isUser: boolean;
  };
  chat: {
    id: string;     // ROWID as string (stable per chat.db install)
    guid: string;   // chat GUID (used for replies via imsg send --chat-guid)
    isGroup: boolean;
    displayName?: string;
  };
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
  reason: "incoming_message" | "chat_not_allowlisted" | "empty_content";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

// Summaries over this length get compressed via the LLM; shorter messages
// use the raw text as the summary.
const SUMMARIZE_THRESHOLD_CHARS = 200;

export async function captureMessage(
  ledger: CaptureLedger,
  msg: CaptureMessage,
  config: ImessageConfig,
  llm: LlmClient,
  opts: { intent?: string } = {}
): Promise<CaptureOutcome> {
  if (!msg.author.isUser) return { captured: false, reason: "incoming_message" };
  if (!config.allowlisted_chats.includes(msg.chat.id)) {
    return { captured: false, reason: "chat_not_allowlisted" };
  }
  if (!msg.content || msg.content.trim().length === 0) {
    return { captured: false, reason: "empty_content" };
  }

  const summary =
    msg.content.length < SUMMARIZE_THRESHOLD_CHARS
      ? msg.content
      : await llm.summarize(msg.content);

  const chatLabel = msg.chat.displayName ?? msg.chat.guid;
  const chatTag = `chat:${chatLabel}`;
  const groupTag = msg.chat.isGroup ? "group" : "dm";

  // Idempotency key: imessage:<chat_guid>:<message_guid>
  const idempotencyKey = `imessage:${msg.chat.guid}:${msg.id}`;

  const result = ledger.appendEvent(
    {
      domain: "communication",
      summary,
      intent: opts.intent ?? "user_message",
      outcome: "success",
      detail: {
        chat_guid: msg.chat.guid,
        chat_id: msg.chat.id,
        chat_display_name: msg.chat.displayName ?? null,
        is_group: msg.chat.isGroup,
        raw_content: msg.content,
      },
      tags: ["chat", "imessage", chatTag, groupTag],
      channel_id: msg.chat.id,
      external_user_id: msg.author.id,
    },
    "imessage",
    idempotencyKey,
    "imessage-watcher"
  );

  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
