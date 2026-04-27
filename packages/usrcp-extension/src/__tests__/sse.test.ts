/**
 * SSE parser unit tests (packages/usrcp-extension/src/__tests__/sse.test.ts)
 *
 * All fixtures are synthetic — no live claude.ai captures. Tests cover:
 *   - Happy path: full stream with multiple deltas assembles correctly
 *   - extractConversationId: URL pattern matching
 *   - message_stop → complete: true
 *   - Streams with unknown event types: they are silently ignored
 *   - Empty stream: returns { turn: null, complete: false }
 *   - Malformed JSON data line: does not crash; remainder parses correctly
 *   - Trailing content without a final blank line: still flushes
 *   - Non-text_delta content blocks (e.g. tool calls): ignored in v0
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSSEStream, extractConversationId } from "../sse.js";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// extractConversationId
// ---------------------------------------------------------------------------

describe("extractConversationId", () => {
  it("extracts the conversation_id from a standard claude.ai completion URL", () => {
    const url =
      "https://claude.ai/api/organizations/org-abc123/chat_conversations/conv-xyz789/completion";
    expect(extractConversationId(url)).toBe("conv-xyz789");
  });

  it("returns 'unknown' for URLs that don't match the pattern", () => {
    expect(extractConversationId("https://claude.ai/chat")).toBe("unknown");
  });

  it("handles UUIDs as conversation IDs", () => {
    const url =
      "https://claude.ai/api/organizations/abc/chat_conversations/550e8400-e29b-41d4-a716-446655440000/completion";
    expect(extractConversationId(url)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});

// ---------------------------------------------------------------------------
// parseSSEStream — happy path
// ---------------------------------------------------------------------------

describe("parseSSEStream — happy path (recorded fixture)", () => {
  const RAW = loadFixture("claude-completion.txt");
  const CONV_ID = "conv-xyz789";

  it("returns a non-null turn", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(turn).not.toBeNull();
  });

  it("assembles text deltas into the correct content", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(turn!.content).toBe(
      "Hello! I remember we discussed the USRCP project last Tuesday."
    );
  });

  it("sets role to 'assistant'", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(turn!.role).toBe("assistant");
  });

  it("carries the conversation_id from the parameter", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(turn!.conversation_id).toBe(CONV_ID);
  });

  it("captures the message_id from message_start", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(turn!.id).toBe("msg_01XabcDefGhiJklMno");
  });

  it("returns complete: true when message_stop is present", () => {
    const { complete } = parseSSEStream(RAW, CONV_ID);
    expect(complete).toBe(true);
  });

  it("sets a valid ISO timestamp", () => {
    const { turn } = parseSSEStream(RAW, CONV_ID);
    expect(() => new Date(turn!.timestamp)).not.toThrow();
    expect(turn!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// parseSSEStream — edge cases
// ---------------------------------------------------------------------------

describe("parseSSEStream — edge cases", () => {
  it("returns { turn: null, complete: false } for an empty stream", () => {
    const { turn, complete } = parseSSEStream("", "conv-1");
    expect(turn).toBeNull();
    expect(complete).toBe(false);
  });

  it("returns complete: false when no message_stop is present", () => {
    const partial = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      "",
    ].join("\n");
    const { complete } = parseSSEStream(partial, "conv-1");
    expect(complete).toBe(false);
  });

  it("silently ignores malformed JSON data lines and continues parsing", () => {
    const stream = [
      "event: content_block_delta",
      "data: {not valid json",
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const { turn, complete } = parseSSEStream(stream, "conv-1");
    // The good delta should still be collected
    expect(turn?.content).toBe("ok");
    expect(complete).toBe(true);
  });

  it("ignores unknown event types without crashing", () => {
    const stream = [
      "event: unknown_future_event",
      'data: {"type":"unknown_future_event","payload":{}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      "",
    ].join("\n");
    const { turn } = parseSSEStream(stream, "conv-1");
    expect(turn?.content).toBe("hello");
  });

  it("ignores non-text_delta delta types (e.g. tool_use)", () => {
    const stream = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"text only"}}',
      "",
    ].join("\n");
    const { turn } = parseSSEStream(stream, "conv-1");
    expect(turn?.content).toBe("text only");
  });

  it("flushes a trailing event not followed by a blank line", () => {
    // No trailing newline after the last data line
    const stream =
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"trailing"}}';
    const { turn } = parseSSEStream(stream, "conv-1");
    expect(turn?.content).toBe("trailing");
  });
});
