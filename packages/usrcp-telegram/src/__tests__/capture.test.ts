/**
 * Integration tests for the Telegram capture pipeline.
 *
 * Criteria verified here:
 *
 *   Criterion 1 — Messages in allowlisted chats produce encrypted
 *                 timeline_events rows with channel_id populated.
 *   Criterion 3 — After ledger close + re-open (simulating bot restart),
 *                 captured events are still readable.
 *   Criterion 4 — Raw SQLite inspection shows ciphertext, never plaintext,
 *                 in the channel_id / thread_id / external_user_id columns.
 *   Criterion 5 — Messages in non-allowlisted chats or from other users
 *                 are skipped.
 *
 * No real Telegram credentials are used — all message shapes are plain
 * objects matching the CaptureMessage interface.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import type { TelegramConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const stubLlm: LlmClient = {
  async summarize() { return "[LLM-SUMMARY]"; },
  async reply() { return "[LLM-REPLY]"; },
};

// Telegram user IDs and chat IDs are integers; we stringify for storage.
const USER_ID = "111222333";
const CHAT_A = "-1001234567890";   // supergroup (negative IDs)
const CHAT_B = "-1009876543210";
const CHAT_UNLISTED = "-1001111111111";

const config: TelegramConfig = {
  telegram_bot_token: "stub-token",
  anthropic_api_key: "stub-key",
  allowlisted_chats: [CHAT_A, CHAT_B],
  user_id: USER_ID,
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

function mkMsg(overrides: Partial<CaptureMessage> & { channel: CaptureMessage["channel"] }): CaptureMessage {
  return {
    id: String(Math.floor(Math.random() * 1_000_000)),
    content: "hello from Telegram",
    author: { id: USER_ID, bot: false },
    thread: null,
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-telegram-capture-"));
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

describe("Criterion 1 — captured rows have channel_id populated + indexed", () => {
  it("captures a message from an allowlisted chat", async () => {
    const msg = mkMsg({
      content: "working on the USRCP telegram adapter",
      channel: { id: CHAT_A, name: "test-group-a" },
    });

    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        "SELECT event_id, channel_id, thread_id, external_user_id, channel_hash FROM timeline_events"
      )
      .get() as Record<string, unknown> | undefined;
    raw.close();

    expect(row).toBeTruthy();
    expect(row!.channel_id).toBeTruthy();
    expect(row!.external_user_id).toBeTruthy();
    expect(String(row!.channel_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getRecentEventsByChannel returns only events from that chat", async () => {
    for (let i = 0; i < 3; i++) {
      await captureMessage(
        ledger,
        mkMsg({ content: `A-${i}`, channel: { id: CHAT_A, name: "group-a" } }),
        config,
        stubLlm
      );
    }
    await captureMessage(
      ledger,
      mkMsg({ content: "B-0", channel: { id: CHAT_B, name: "group-b" } }),
      config,
      stubLlm
    );

    const aEvents = ledger.getRecentEventsByChannel(CHAT_A, 10);
    expect(aEvents.length).toBe(3);
    for (const e of aEvents) {
      expect(e.channel_id).toBe(CHAT_A);
    }

    const bEvents = ledger.getRecentEventsByChannel(CHAT_B, 10);
    expect(bEvents.length).toBe(1);
    expect(bEvents[0].channel_id).toBe(CHAT_B);
  });

  it("idempotency_key prevents double-capture of the same Telegram message", async () => {
    const msg = mkMsg({
      content: "same message twice",
      channel: { id: CHAT_A, name: "group-a" },
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

describe("Criterion 3 — restart persistence", () => {
  it("events survive close + re-open with the same key material", async () => {
    const msg = mkMsg({
      content: "I am working on the USRCP telegram adapter",
      channel: { id: CHAT_A, name: "group-a" },
    });
    const captured = await captureMessage(ledger, msg, config, stubLlm);
    expect(captured.captured).toBe(true);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const timeline = reopened.getTimeline({ last_n: 10 });
      expect(timeline.length).toBe(1);
      expect(timeline[0].channel_id).toBe(CHAT_A);
      expect(timeline[0].summary).toContain("USRCP telegram adapter");

      const byChannel = reopened.getRecentEventsByChannel(CHAT_A, 10);
      expect(byChannel.length).toBe(1);
    } finally {
      reopened.close();
      ledger = new Ledger(dbPath);
    }
  });
});

describe("Criterion 4 — ciphertext at rest, never plaintext", () => {
  it("channel_id / thread_id / external_user_id / detail are all encrypted", async () => {
    const plaintextMarkers = {
      chat: CHAT_A,
      thread: "77777",
      user: USER_ID,
      content: "distinctive-plaintext-PINK-ELEPHANT-sentinel-value",
    };

    const msg = mkMsg({
      id: "99999",
      content: plaintextMarkers.content,
      channel: { id: plaintextMarkers.chat, name: "group-a" },
      thread: { id: plaintextMarkers.thread },
      author: { id: plaintextMarkers.user, bot: false },
    });
    const captured = await captureMessage(ledger, msg, config, stubLlm);
    expect(captured.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT channel_id, thread_id, external_user_id, summary, detail, tags,
                channel_hash
         FROM timeline_events`
      )
      .get() as Record<string, string> | undefined;
    raw.close();

    expect(row).toBeTruthy();
    // Encrypted columns must start with "enc:"
    expect(row!.channel_id.startsWith("enc:")).toBe(true);
    expect(row!.thread_id.startsWith("enc:")).toBe(true);
    expect(row!.external_user_id.startsWith("enc:")).toBe(true);
    expect(row!.summary.startsWith("enc:")).toBe(true);
    expect(row!.detail.startsWith("enc:")).toBe(true);
    expect(row!.tags.startsWith("enc:")).toBe(true);

    // Plaintext markers must not appear anywhere in ciphertext columns
    for (const col of ["channel_id", "thread_id", "external_user_id", "summary", "detail", "tags"] as const) {
      const val = row![col];
      expect(val).not.toContain(plaintextMarkers.chat);
      expect(val).not.toContain(plaintextMarkers.thread);
      expect(val).not.toContain(plaintextMarkers.user);
      expect(val).not.toContain(plaintextMarkers.content);
    }

    // channel_hash is a deterministic HMAC — hex, 64 chars, not ciphertext
    expect(row!.channel_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.channel_hash).not.toBe(plaintextMarkers.chat);
  });

  it("Ledger read decrypts channel_id back to plaintext", async () => {
    const msg = mkMsg({
      content: "roundtrip check",
      channel: { id: CHAT_A, name: "group-a" },
      thread: { id: "42" },
    });
    await captureMessage(ledger, msg, config, stubLlm);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].channel_id).toBe(CHAT_A);
    expect(events[0].thread_id).toBe("42");
    expect(events[0].external_user_id).toBe(USER_ID);
  });
});

describe("Criterion 5 — chat allowlist filter + user filter", () => {
  it("skips messages in non-allowlisted chats", async () => {
    const msg = mkMsg({
      content: "should not be captured",
      channel: { id: CHAT_UNLISTED, name: "off-limits" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("channel_not_allowlisted");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });

  it("skips messages from other users even in allowlisted chats", async () => {
    const msg = mkMsg({
      content: "someone else's message",
      channel: { id: CHAT_A, name: "group-a" },
      author: { id: "999888777", bot: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("other_user");
  });

  it("skips bot messages", async () => {
    const msg = mkMsg({
      content: "bot said something",
      channel: { id: CHAT_A, name: "group-a" },
      author: { id: USER_ID, bot: true },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("bot_author");
  });

  it("skips empty messages (e.g., photo-only posts without caption)", async () => {
    const msg = mkMsg({
      content: "   ",
      channel: { id: CHAT_A, name: "group-a" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_content");
  });
});
