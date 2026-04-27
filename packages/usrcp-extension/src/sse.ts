/**
 * SSE parser for claude.ai's completion endpoint.
 *
 * The endpoint streams newline-separated Server-Sent Events. Each line is
 * either:
 *   event: <event_type>
 *   data: <json_payload>
 *   (blank line — end of event)
 *
 * We accumulate `content_block_delta` text deltas into a final assistant turn.
 * Tool-call content blocks and image blocks are ignored in v0.
 *
 * Exported for unit testing. Used by page-hook.ts at runtime.
 */

import type { CapturedTurn } from "./shared/types.js";

// ---------------------------------------------------------------------------
// Types for claude.ai SSE payloads (subset relevant to capture)
// ---------------------------------------------------------------------------

interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    // The conversation_id is carried in the URL, not in the event payload.
    // We receive it as a parameter.
  };
}

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | string;
    text?: string;
  };
}

interface MessageStopEvent {
  type: "message_stop";
}

type ClaudeSSEEvent =
  | MessageStartEvent
  | ContentBlockDeltaEvent
  | MessageStopEvent
  | { type: string }; // catch-all for unknown event types

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

export interface ParseSSEResult {
  turn: CapturedTurn | null;
  /** True if a message_stop event was seen (clean completion). */
  complete: boolean;
}

/**
 * Parse a complete SSE stream (as a string) and return the assembled turn.
 *
 * @param rawStream  The full SSE text (e.g., from a recorded fixture).
 * @param conversationId  The conversation ID extracted from the request URL.
 * @returns ParseSSEResult — turn is null if no content was captured.
 */
export function parseSSEStream(
  rawStream: string,
  conversationId: string
): ParseSSEResult {
  const lines = rawStream.split("\n");

  let messageId = "";
  const textDeltas: string[] = [];
  let complete = false;

  let currentEventType = "";
  const pendingDataLines: string[] = [];

  function flushEvent(): void {
    if (!currentEventType && pendingDataLines.length === 0) return;

    const dataRaw = pendingDataLines.join("\n").trim();
    if (!dataRaw || dataRaw === "[DONE]") {
      currentEventType = "";
      pendingDataLines.length = 0;
      return;
    }

    let payload: ClaudeSSEEvent;
    try {
      payload = JSON.parse(dataRaw) as ClaudeSSEEvent;
    } catch {
      // Malformed JSON — skip
      currentEventType = "";
      pendingDataLines.length = 0;
      return;
    }

    switch (payload.type) {
      case "message_start": {
        const ev = payload as MessageStartEvent;
        messageId = ev.message.id;
        break;
      }
      case "content_block_delta": {
        const ev = payload as ContentBlockDeltaEvent;
        if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
          textDeltas.push(ev.delta.text);
        }
        break;
      }
      case "message_stop":
        complete = true;
        break;
      default:
        // ping, content_block_start, content_block_stop, message_delta, etc. — ignore
        break;
    }

    currentEventType = "";
    pendingDataLines.length = 0;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd(); // preserve leading spaces inside data values

    if (line === "") {
      // Blank line — flush the accumulated event
      flushEvent();
      continue;
    }

    if (line.startsWith("event: ")) {
      currentEventType = line.slice("event: ".length).trim();
    } else if (line.startsWith("data: ")) {
      pendingDataLines.push(line.slice("data: ".length));
    }
    // Lines starting with ":" are SSE comments — skip.
    // Lines without a colon are field names with empty values — skip for our purposes.
  }

  // Flush any trailing event that wasn't followed by a blank line
  flushEvent();

  if (textDeltas.length === 0) {
    return { turn: null, complete };
  }

  const turn: CapturedTurn = {
    id: messageId || `usrcp-${Date.now()}`,
    role: "assistant",
    content: textDeltas.join(""),
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
  };

  return { turn, complete };
}

/**
 * Extract the conversation_id from a claude.ai completion URL.
 *
 * Pattern: /api/organizations/{org}/chat_conversations/{conv_id}/completion
 */
export function extractConversationId(url: string): string {
  const match = /\/chat_conversations\/([^/]+)\/completion/.exec(url);
  return match ? match[1] : "unknown";
}

/**
 * Parse an SSE ReadableStream asynchronously, collecting the full body first,
 * then delegating to parseSSEStream. Used by page-hook.ts.
 */
export async function parseSSEStreamFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  conversationId: string
): Promise<CapturedTurn | null> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode()); // flush

  const { turn } = parseSSEStream(chunks.join(""), conversationId);
  return turn;
}
