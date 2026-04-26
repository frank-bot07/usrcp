/**
 * Integration tests for the iMessage capture pipeline.
 *
 * Verified:
 *   - is_from_me: only user-sent messages (isUser=true) are captured
 *   - chat_not_allowlisted: messages in non-allowlisted chats are skipped
 *   - empty_content: empty messages are skipped
 *   - happy path: messages captured with correct channel_id
 *   - idempotency: same guid+chat_guid is not double-captured
 *   - ciphertext at rest: raw SQLite inspection confirms plaintext not stored
 *   - restart persistence: events survive close + re-open
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import type { ImessageConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const stubLlm: LlmClient = {
  async summarize() { return "[LLM-SUMMARY]"; },
  async reply() { return "[LLM-REPLY]"; },
};

const USER_HANDLE = "+14155551234";
const CHAT_A_ID = "7";
const CHAT_A_GUID = "iMessage;-;chat-a-guid";
const CHAT_B_ID = "9";
const CHAT_B_GUID = "iMessage;-;chat-b-guid";
const CHAT_UNLISTED_ID = "99";
const CHAT_UNLISTED_GUID = "iMessage;-;chat-unlisted";

const config: ImessageConfig = {
  anthropic_api_key: "sk-ant-stub",
  user_handle: USER_HANDLE,
  allowlisted_chats: [CHAT_A_ID, CHAT_B_ID],
  prefix: "..u ",
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

let msgCounter = 0;
function mkMsg(overrides: Partial<CaptureMessage> & { chat: CaptureMessage["chat"] }): CaptureMessage {
  msgCounter++;
  return {
    id: `guid-${msgCounter}-${Math.random().toString(36).slice(2, 8)}`,
    content: "hello from iMessage",
    author: { id: USER_HANDLE, isUser: true },
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-imessage-capture-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  dbPath = path.join(tmpHome, "ledger.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Filter: is_from_me
// ---------------------------------------------------------------------------

describe("filter: is_from_me", () => {
  it("captures messages where isUser === true (is_from_me=1)", async () => {
    const msg = mkMsg({
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(1);
  });

  it("does NOT capture incoming messages (isUser === false)", async () => {
    const msg = mkMsg({
      content: "incoming from someone else",
      author: { id: "+19995551234", isUser: false },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("incoming_message");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filter: chat not allowlisted
// ---------------------------------------------------------------------------

describe("filter: chat_not_allowlisted", () => {
  it("skips messages in a chat not on the allowlist", async () => {
    const msg = mkMsg({
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_UNLISTED_ID, guid: CHAT_UNLISTED_GUID, isGroup: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("chat_not_allowlisted");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filter: empty content
// ---------------------------------------------------------------------------

describe("filter: empty_content", () => {
  it("skips messages with empty or whitespace-only text", async () => {
    const msg = mkMsg({
      content: "   ",
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_content");
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("capture: happy path", () => {
  it("captures a message and populates channel_id + external_user_id", async () => {
    const msg = mkMsg({
      content: "working on the USRCP iMessage adapter",
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false, displayName: "Alice" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare("SELECT event_id, channel_id, external_user_id, channel_hash FROM timeline_events")
      .get() as Record<string, unknown>;
    raw.close();

    expect(row).toBeTruthy();
    expect(row["channel_id"]).toBeTruthy();
    expect(row["external_user_id"]).toBeTruthy();
    expect(typeof row["channel_hash"]).toBe("string");
    expect((row["channel_hash"] as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getRecentEventsByChannel returns only events from that chat", async () => {
    for (let i = 0; i < 3; i++) {
      await captureMessage(
        ledger,
        mkMsg({
          content: `A-${i}`,
          author: { id: USER_HANDLE, isUser: true },
          chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
        }),
        config, stubLlm
      );
    }
    await captureMessage(
      ledger,
      mkMsg({
        content: "B-0",
        author: { id: USER_HANDLE, isUser: true },
        chat: { id: CHAT_B_ID, guid: CHAT_B_GUID, isGroup: false },
      }),
      config, stubLlm
    );

    const aEvents = ledger.getRecentEventsByChannel(CHAT_A_ID, 10);
    expect(aEvents.length).toBe(3);

    const bEvents = ledger.getRecentEventsByChannel(CHAT_B_ID, 10);
    expect(bEvents.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("does not double-capture the same guid+chat_guid combination", async () => {
    const msg = mkMsg({
      content: "same message twice",
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    const first = await captureMessage(ledger, msg, config, stubLlm);
    expect(first.captured).toBe(true);
    if (!first.captured) throw new Error("unreachable");
    expect(first.duplicate).toBe(false);

    const second = await captureMessage(ledger, msg, config, stubLlm);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    expect(second.event_id).toBe(first.event_id);

    const timeline = ledger.getTimeline({ last_n: 100 });
    expect(timeline.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ciphertext at rest
// ---------------------------------------------------------------------------

describe("ciphertext at rest", () => {
  it("channel_id / external_user_id / summary / detail are all encrypted", async () => {
    const plaintextMarkers = {
      chatId: "IMSG-CHAT-777777-DISTINCTMARKER",
      chatGuid: "iMessage;-;distinctmarker-chat-guid-TURQUOISE",
      user: "+19876543000DISTINCTMARKER",
      content: "distinctive-plaintext-TURQUOISE-ELEPHANT-imessage-sentinel",
    };

    const markerConfig: ImessageConfig = {
      ...config,
      user_handle: plaintextMarkers.user,
      allowlisted_chats: [plaintextMarkers.chatId],
    };

    const msg = mkMsg({
      content: plaintextMarkers.content,
      author: { id: plaintextMarkers.user, isUser: true },
      chat: { id: plaintextMarkers.chatId, guid: plaintextMarkers.chatGuid, isGroup: false },
    });
    const result = await captureMessage(ledger, msg, markerConfig, stubLlm);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT channel_id, external_user_id, summary, detail, tags, channel_hash
         FROM timeline_events`
      )
      .get() as Record<string, string>;
    raw.close();

    // Encrypted columns must start with "enc:"
    expect(row["channel_id"].startsWith("enc:")).toBe(true);
    expect(row["external_user_id"].startsWith("enc:")).toBe(true);
    expect(row["summary"].startsWith("enc:")).toBe(true);
    expect(row["detail"].startsWith("enc:")).toBe(true);
    expect(row["tags"].startsWith("enc:")).toBe(true);

    // Plaintext markers must not appear in ciphertexts
    for (const col of ["channel_id", "external_user_id", "summary", "detail", "tags"]) {
      const val = row[col];
      expect(val).not.toContain(plaintextMarkers.chatId);
      expect(val).not.toContain(plaintextMarkers.chatGuid);
      expect(val).not.toContain(plaintextMarkers.user);
      expect(val).not.toContain(plaintextMarkers.content);
    }

    // channel_hash is deterministic HMAC — hex, 64 chars, not the plaintext ID
    expect(row["channel_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["channel_hash"]).not.toBe(plaintextMarkers.chatId);
  });

  it("decrypted channel_id + external_user_id round-trip through Ledger read", async () => {
    const msg = mkMsg({
      content: "roundtrip check",
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    await captureMessage(ledger, msg, config, stubLlm);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].channel_id).toBe(CHAT_A_ID);
    expect(events[0].external_user_id).toBe(USER_HANDLE);
  });
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

describe("restart persistence", () => {
  it("events survive ledger close + re-open", async () => {
    const msg = mkMsg({
      content: "iMessage persistence check",
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });
    const captured = await captureMessage(ledger, msg, config, stubLlm);
    expect(captured.captured).toBe(true);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const timeline = reopened.getTimeline({ last_n: 10 });
      expect(timeline.length).toBe(1);
      expect(timeline[0].channel_id).toBe(CHAT_A_ID);
      expect(timeline[0].summary).toContain("persistence check");

      const byChannel = reopened.getRecentEventsByChannel(CHAT_A_ID, 10);
      expect(byChannel.length).toBe(1);
    } finally {
      reopened.close();
      ledger = new Ledger(dbPath); // so afterEach close() doesn't double-close
    }
  });
});
