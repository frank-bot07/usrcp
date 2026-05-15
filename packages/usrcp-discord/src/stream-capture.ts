/**
 * Stream-side capture pipeline for Discord. Sibling of capture.ts:
 *   capture.ts        -> ledger.appendEvent (filters to user's own messages)
 *   stream-capture.ts -> stream client (captures BOTH sides on allowlisted
 *                                       channels; skips bots and empties)
 *
 * The stream path bypasses the user-only filter on purpose: bidirectional
 * conversation capture is the whole reason usrcp-stream exists. See
 * packages/usrcp-stream/README.md "What stream adds over usrcp-local".
 */

import type { CaptureMessage } from "./capture.js";
import type { DiscordConfig } from "./config.js";

const SURFACE = "discord";

// Duck-typed client subset we need from createStreamCaptureClient.
// Importing the concrete type would couple this file to a built dist
// path; tests stay easier with structural matching.
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
  reason: "bot_author" | "channel_not_allowlisted" | "empty_content";
}

export type StreamCaptureOutcome = StreamCaptureResult | StreamCaptureSkipped;

export async function captureMessageToStream(
  client: StreamCaptureClientLike,
  msg: CaptureMessage,
  config: DiscordConfig
): Promise<StreamCaptureOutcome> {
  if (msg.author.bot) return { captured: false, reason: "bot_author" };
  if (!config.allowlisted_channels.includes(msg.channel.id)) {
    return { captured: false, reason: "channel_not_allowlisted" };
  }
  if (!msg.content || msg.content.trim().length === 0) {
    return { captured: false, reason: "empty_content" };
  }

  const side: "inbound" | "outbound" =
    msg.author.id === config.user_id ? "outbound" : "inbound";

  const channel_ref: Record<string, unknown> = {
    channel: msg.channel.id,
  };
  if (msg.guild?.id) channel_ref.guild = msg.guild.id;
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
