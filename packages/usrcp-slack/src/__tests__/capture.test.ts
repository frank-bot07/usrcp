/**
 * Integration tests for the Slack capture pipeline.
 *
 * Verified:
 *   - bot_author: bot-attributed messages are skipped
 *   - other_user: messages from non-configured users are skipped
 *   - channel_not_allowlisted: off-list channels are skipped
 *   - empty_content: messages with no text are skipped
 *   - happy path: messages are captured with correct channel_id + thread_id
 *   - idempotency: same Slack ts+channel key is not double-captured
 *   - ciphertext at rest: raw SQLite inspection confirms plaintext never stored
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
import type { SlackConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const stubLlm: LlmClient = {
  async summarize() { return "[LLM-SUMMARY]"; },
  async reply() { return "[LLM-REPLY]"; },
};

const USER_ID = "U01234567890";
const CHANNEL_A = "C01234567890";
const CHANNEL_B = "C09876543210";
const CHANNEL_UNLISTED = "C99999999999";
const TEAM_ID = "T01234567890";

const config: SlackConfig = {
  slack_bot_token: "xoxb-stub",
  slack_app_token: "xapp-stub",
  anthropic_api_key: "sk-ant-stub",
  allowlisted_channels: [CHANNEL_A, CHANNEL_B],
  user_id: USER_ID,
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

function mkMsg(overrides: Partial<CaptureMessage> & { channel: CaptureMessage["channel"] }): CaptureMessage {
  return {
    id: `ts_${Math.random().toString(36).slice(2, 10)}`,
    content: "hello from Slack",
    author: { id: USER_ID, bot: false },
    thread: null,
    team_id: TEAM_ID,
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-slack-capture-"));
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
// Filter rules
// ---------------------------------------------------------------------------

describe("filter: bot_author", () => {
  it("skips messages with author.bot === true", async () => {
    const msg = mkMsg({
      channel: { id: CHANNEL_A, name: "general" },
      author: { id: USER_ID, bot: true },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("bot_author");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });

  it("skips Bolt GenericMessageEvents with a bot_id (workflow bot) by using bot: true", async () => {
    // index.ts sets author.bot = true when bot_id is set. Simulate that here.
    const msg = mkMsg({
      channel: { id: CHANNEL_A, name: "general" },
      author: { id: "W01234567890", bot: true },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("bot_author");
  });
});

describe("filter: other_user", () => {
  it("skips messages from a user other than the configured user_id", async () => {
    const msg = mkMsg({
      channel: { id: CHANNEL_A, name: "general" },
      author: { id: "U_SOMEONE_ELSE", bot: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("other_user");
  });
});

describe("filter: channel_not_allowlisted", () => {
  it("skips messages in a channel not on the allowlist", async () => {
    const msg = mkMsg({
      channel: { id: CHANNEL_UNLISTED, name: "secret" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("channel_not_allowlisted");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });
});

describe("filter: empty_content", () => {
  it("skips messages with empty or whitespace-only text", async () => {
    const msg = mkMsg({
      channel: { id: CHANNEL_A, name: "general" },
      content: "   ",
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
  it("captures a message from an allowlisted channel and populates channel_id", async () => {
    const msg = mkMsg({
      content: "I am working on the USRCP slack adapter",
      channel: { id: CHANNEL_A, name: "general" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare("SELECT event_id, channel_id, thread_id, external_user_id, channel_hash FROM timeline_events")
      .get() as Record<string, unknown>;
    raw.close();

    expect(row).toBeTruthy();
    expect(row["channel_id"]).toBeTruthy();
    expect(row["external_user_id"]).toBeTruthy();
    expect(typeof row["channel_hash"]).toBe("string");
    expect((row["channel_hash"] as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves thread_ts in the ledger event thread_id field", async () => {
    const THREAD_TS = "1234567890.123456";
    const msg = mkMsg({
      content: "a reply in a thread",
      channel: { id: CHANNEL_A, name: "general" },
      thread: { id: THREAD_TS },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].thread_id).toBe(THREAD_TS);
  });

  it("getRecentEventsByChannel returns only events from that channel", async () => {
    for (let i = 0; i < 3; i++) {
      await captureMessage(
        ledger,
        mkMsg({ content: `A-${i}`, channel: { id: CHANNEL_A, name: "general" } }),
        config, stubLlm
      );
    }
    await captureMessage(
      ledger,
      mkMsg({ content: "B-0", channel: { id: CHANNEL_B, name: "random" } }),
      config, stubLlm
    );

    const aEvents = ledger.getRecentEventsByChannel(CHANNEL_A, 10);
    expect(aEvents.length).toBe(3);

    const bEvents = ledger.getRecentEventsByChannel(CHANNEL_B, 10);
    expect(bEvents.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("does not double-capture the same Slack ts+channel combination", async () => {
    const msg = mkMsg({
      content: "same message twice",
      channel: { id: CHANNEL_A, name: "general" },
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
  it("channel_id / thread_id / external_user_id / summary / detail are all encrypted", async () => {
    const plaintextMarkers = {
      channel: CHANNEL_A,
      thread: "ts_thread_987654",
      user: USER_ID,
      content: "distinctive-plaintext-TURQUOISE-ELEPHANT-sentinel-value",
    };

    const msg = mkMsg({
      content: plaintextMarkers.content,
      channel: { id: plaintextMarkers.channel, name: "general" },
      thread: { id: plaintextMarkers.thread },
      author: { id: plaintextMarkers.user, bot: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT channel_id, thread_id, external_user_id, summary, detail, tags, channel_hash
         FROM timeline_events`
      )
      .get() as Record<string, string>;
    raw.close();

    // Encrypted columns must start with "enc:"
    expect(row["channel_id"].startsWith("enc:")).toBe(true);
    expect(row["thread_id"].startsWith("enc:")).toBe(true);
    expect(row["external_user_id"].startsWith("enc:")).toBe(true);
    expect(row["summary"].startsWith("enc:")).toBe(true);
    expect(row["detail"].startsWith("enc:")).toBe(true);
    expect(row["tags"].startsWith("enc:")).toBe(true);

    // Plaintext markers must not appear anywhere in the ciphertexts
    for (const col of ["channel_id", "thread_id", "external_user_id", "summary", "detail", "tags"]) {
      const val = row[col];
      expect(val).not.toContain(plaintextMarkers.channel);
      expect(val).not.toContain(plaintextMarkers.thread);
      expect(val).not.toContain(plaintextMarkers.user);
      expect(val).not.toContain(plaintextMarkers.content);
    }

    // channel_hash is deterministic HMAC — hex, 64 chars, not the plaintext ID
    expect(row["channel_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["channel_hash"]).not.toBe(plaintextMarkers.channel);
  });

  it("decrypted channel_id + thread_id round-trips through Ledger read", async () => {
    const THREAD_TS = "ts_roundtrip_42";
    const msg = mkMsg({
      content: "roundtrip check",
      channel: { id: CHANNEL_A, name: "general" },
      thread: { id: THREAD_TS },
    });
    await captureMessage(ledger, msg, config, stubLlm);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].channel_id).toBe(CHANNEL_A);
    expect(events[0].thread_id).toBe(THREAD_TS);
    expect(events[0].external_user_id).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

describe("restart persistence", () => {
  it("events survive ledger close + re-open", async () => {
    const msg = mkMsg({
      content: "I am working on the USRCP slack adapter",
      channel: { id: CHANNEL_A, name: "general" },
    });
    const captured = await captureMessage(ledger, msg, config, stubLlm);
    expect(captured.captured).toBe(true);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const timeline = reopened.getTimeline({ last_n: 10 });
      expect(timeline.length).toBe(1);
      expect(timeline[0].channel_id).toBe(CHANNEL_A);
      expect(timeline[0].summary).toContain("USRCP slack adapter");

      const byChannel = reopened.getRecentEventsByChannel(CHANNEL_A, 10);
      expect(byChannel.length).toBe(1);
    } finally {
      reopened.close();
      ledger = new Ledger(dbPath); // so afterEach close() doesn't double-close
    }
  });
});
