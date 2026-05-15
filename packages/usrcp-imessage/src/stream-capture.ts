/**
 * Stream-side capture pipeline for iMessage. iMessage has no notion of
 * "bot", so the bot filter doesn't apply; the inbound/outbound split
 * comes directly from the is_from_me flag carried as `author.isUser`.
 */

import type { CaptureMessage } from "./capture.js";
import type { ImessageConfig } from "./config.js";

const SURFACE = "imessage";

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
  reason: "chat_not_allowlisted" | "empty_content";
}

export type StreamCaptureOutcome = StreamCaptureResult | StreamCaptureSkipped;

export async function captureMessageToStream(
  client: StreamCaptureClientLike,
  msg: CaptureMessage,
  config: ImessageConfig
): Promise<StreamCaptureOutcome> {
  if (!config.allowlisted_chats.includes(msg.chat.id)) {
    return { captured: false, reason: "chat_not_allowlisted" };
  }
  if (!msg.content || msg.content.trim().length === 0) {
    return { captured: false, reason: "empty_content" };
  }

  const side: "inbound" | "outbound" = msg.author.isUser ? "outbound" : "inbound";

  const channel_ref: Record<string, unknown> = {
    chatId: msg.chat.id,
    chatGuid: msg.chat.guid,
    isGroup: msg.chat.isGroup,
  };

  const result = await client.capture({
    surface: SURFACE,
    channel_ref,
    side,
    author_ref: {
      id: msg.author.id,
      displayName: msg.author.displayName ?? msg.chat.displayName,
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
