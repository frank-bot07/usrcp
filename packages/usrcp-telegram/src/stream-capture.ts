/**
 * Stream-side capture pipeline for Telegram. Mirrors usrcp-discord's
 * stream-capture.ts; see that file's header for the design rationale.
 */

import type { CaptureMessage } from "./capture.js";
import type { TelegramConfig } from "./config.js";

const SURFACE = "telegram";

export interface StreamCaptureClientLike {
  capture(event: {
    surface: string;
    channel_ref: Record<string, unknown>;
    side: "inbound" | "outbound" | "system";
    author_ref: { id: string; displayName?: string };
    content: string;
    content_kind: "text" | "code" | "image-caption" | "tool-call" | "tool-result";
    ts_ms: number;
    entity_refs?: string[];
  }): Promise<{ event_uuid: string; thread_id: string | null; ingested_at: number }>;
}

export interface StreamCaptureResult {
  captured: true;
  event_uuid: string;
  thread_id: string | null;
  side: "inbound" | "outbound";
}

export interface StreamCaptureSkipped {
  captured: false;
  reason: "bot_author" | "chat_not_allowlisted" | "empty_content";
}

export type StreamCaptureOutcome = StreamCaptureResult | StreamCaptureSkipped;

export async function captureMessageToStream(
  client: StreamCaptureClientLike,
  msg: CaptureMessage,
  config: TelegramConfig
): Promise<StreamCaptureOutcome> {
  if (msg.author.bot) return { captured: false, reason: "bot_author" };
  if (!config.allowlisted_chats.includes(msg.channel.id)) {
    return { captured: false, reason: "chat_not_allowlisted" };
  }
  if (!msg.content || msg.content.trim().length === 0) {
    return { captured: false, reason: "empty_content" };
  }

  const side: "inbound" | "outbound" =
    msg.author.id === config.user_id ? "outbound" : "inbound";

  const channel_ref: Record<string, unknown> = {
    chatId: msg.channel.id,
  };
  if (msg.thread?.id) channel_ref.thread = msg.thread.id;

  const result = await client.capture({
    surface: SURFACE,
    channel_ref,
    side,
    author_ref: {
      id: msg.author.id,
      displayName: msg.author.displayName ?? msg.channel.name,
    },
    content: msg.content,
    content_kind: "text",
    ts_ms: msg.ts_ms,
  });

  return {
    captured: true,
    event_uuid: result.event_uuid,
    thread_id: result.thread_id,
    side,
  };
}
