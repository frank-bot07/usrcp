/**
 * Integration tests for the capture pipeline + schema additions.
 *
 * These tests exercise the four acceptance criteria the user asked me to
 * self-verify for Task 00:
 *
 *   Criterion 1 — Messages in allowlisted channels produce encrypted
 *                 timeline_events rows with channel_id populated.
 *   Criterion 3 — After ledger close + re-open (simulating bot restart),
 *                 the captured events are still readable.
 *   Criterion 4 — Raw SQLite inspection shows ciphertext, never plaintext,
 *                 in the new channel_id / thread_id / external_user_id
 *                 columns.
 *   Criterion 5 — Messages in non-allowlisted channels are not captured.
 *
 * Criterion 2 (bot replies referencing cross-channel context) requires a
 * live Discord gateway connection and is intentionally not covered here —
 * it's the manual checklist in packages/usrcp-discord/DEMO.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import type { DiscordConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

// Stub LLM — no network, no API key needed. Summarize returns a sentinel
// so we can assert the short-message short-circuit path is taken.
const stubLlm: LlmClient = {
  async summarize() {
    return "[LLM-SUMMARY]";
  },
  async reply() {
    return "[LLM-REPLY]";
  },
};

const USER_ID = "123456789012345678";
const CHANNEL_A = "ch_allowed_a";
const CHANNEL_B = "ch_allowed_b";
const CHANNEL_UNLISTED = "ch_not_allowed";

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

const config: DiscordConfig = {
  discord_bot_token: "stub-token",
  anthropic_api_key: "stub-key",
  allowlisted_channels: [CHANNEL_A, CHANNEL_B],
  user_id: USER_ID,
};

function mkMsg(overrides: Partial<CaptureMessage> & { channel: CaptureMessage["channel"] }): CaptureMessage {
  return {
    id: "msg_" + Math.random().toString(36).slice(2, 10),
    content: "hello world",
    author: { id: USER_ID, bot: false },
    guild: { id: "guild_1", name: "test-guild" },
    thread: null,
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-discord-capture-"));
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
  it("captures a message from an allowlisted channel", async () => {
    const msg = mkMsg({
      content: "working on the USRCP discord adapter",
      channel: { id: CHANNEL_A, name: "test-a" },
    });

    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(true);

    // Look at the raw row
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        "SELECT event_id, channel_id, thread_id, external_user_id, channel_hash FROM timeline_events"
      )
      .get() as any;
    raw.close();

    expect(row).toBeTruthy();
    expect(row.channel_id).toBeTruthy();
    expect(row.external_user_id).toBeTruthy();
    expect(row.channel_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getRecentEventsByChannel returns only events from that channel", async () => {
    for (let i = 0; i < 3; i++) {
      await captureMessage(
        ledger,
        mkMsg({ content: `A-${i}`, channel: { id: CHANNEL_A, name: "test-a" } }),
        config,
        stubLlm
      );
    }
    await captureMessage(
      ledger,
      mkMsg({ content: "B-0", channel: { id: CHANNEL_B, name: "test-b" } }),
      config,
      stubLlm
    );

    const aEvents = ledger.getRecentEventsByChannel(CHANNEL_A, 10);
    expect(aEvents.length).toBe(3);
    for (const e of aEvents) {
      expect(e.channel_id).toBe(CHANNEL_A);
    }

    const bEvents = ledger.getRecentEventsByChannel(CHANNEL_B, 10);
    expect(bEvents.length).toBe(1);
    expect(bEvents[0].channel_id).toBe(CHANNEL_B);
  });

  it("idempotency_key prevents double-capture of the same Discord message ID", async () => {
    const msg = mkMsg({
      content: "same message twice",
      channel: { id: CHANNEL_A, name: "test-a" },
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
      content: "I am working on the USRCP discord adapter",
      channel: { id: CHANNEL_A, name: "test-a" },
    });
    const captured = await captureMessage(ledger, msg, config, stubLlm);
    expect(captured.captured).toBe(true);
    ledger.close();

    // Simulate restart: same dbPath, same HOME (so same keys/ dir), new process
    const reopened = new Ledger(dbPath);
    try {
      const timeline = reopened.getTimeline({ last_n: 10 });
      expect(timeline.length).toBe(1);
      expect(timeline[0].channel_id).toBe(CHANNEL_A);
      expect(timeline[0].summary).toContain("USRCP discord adapter");

      const byChannel = reopened.getRecentEventsByChannel(CHANNEL_A, 10);
      expect(byChannel.length).toBe(1);
    } finally {
      reopened.close();
      // Re-open an instance so the afterEach close() on `ledger` doesn't
      // double-close the already-closed connection.
      ledger = new Ledger(dbPath);
    }
  });
});

describe("Criterion 4 — ciphertext at rest, never plaintext", () => {
  it("channel_id / thread_id / external_user_id / detail are all encrypted", async () => {
    const plaintextMarkers = {
      channel: CHANNEL_A,
      thread: "thread_987",
      user: USER_ID,
      content: "distinctive-plaintext-PINK-ELEPHANT-sentinel-value",
    };

    const msg = mkMsg({
      content: plaintextMarkers.content,
      channel: { id: plaintextMarkers.channel, name: "test-a" },
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
      .get() as any;
    raw.close();

    // Encrypted columns must start with "enc:"
    expect(row.channel_id.startsWith("enc:")).toBe(true);
    expect(row.thread_id.startsWith("enc:")).toBe(true);
    expect(row.external_user_id.startsWith("enc:")).toBe(true);
    expect(row.summary.startsWith("enc:")).toBe(true);
    expect(row.detail.startsWith("enc:")).toBe(true);
    expect(row.tags.startsWith("enc:")).toBe(true);

    // And the plaintext markers must not appear anywhere in those ciphertexts
    for (const col of ["channel_id", "thread_id", "external_user_id", "summary", "detail", "tags"]) {
      const val: string = row[col];
      expect(val).not.toContain(plaintextMarkers.channel);
      expect(val).not.toContain(plaintextMarkers.thread);
      expect(val).not.toContain(plaintextMarkers.user);
      expect(val).not.toContain(plaintextMarkers.content);
    }

    // channel_hash is a deterministic HMAC — hex, 64 chars, not ciphertext.
    expect(row.channel_hash).toMatch(/^[0-9a-f]{64}$/);
    // And it must not be the plaintext channel ID itself.
    expect(row.channel_hash).not.toBe(plaintextMarkers.channel);
  });

  it("Ledger read decrypts channel_id back to plaintext", async () => {
    const msg = mkMsg({
      content: "roundtrip check",
      channel: { id: CHANNEL_A, name: "test-a" },
      thread: { id: "thread_42" },
    });
    await captureMessage(ledger, msg, config, stubLlm);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].channel_id).toBe(CHANNEL_A);
    expect(events[0].thread_id).toBe("thread_42");
    expect(events[0].external_user_id).toBe(USER_ID);
  });
});

describe("Criterion 5 — channel allowlist filter", () => {
  it("skips messages in non-allowlisted channels", async () => {
    const msg = mkMsg({
      content: "should not be captured",
      channel: { id: CHANNEL_UNLISTED, name: "off-limits" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("channel_not_allowlisted");

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(0);
  });

  it("skips messages from other users even in allowlisted channels", async () => {
    const msg = mkMsg({
      content: "someone else's message",
      channel: { id: CHANNEL_A, name: "test-a" },
      author: { id: "some-other-user-id", bot: false },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("other_user");
  });

  it("skips bot messages", async () => {
    const msg = mkMsg({
      content: "bot said something",
      channel: { id: CHANNEL_A, name: "test-a" },
      author: { id: USER_ID, bot: true },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("bot_author");
  });

  it("skips empty messages (e.g., image-only posts without text)", async () => {
    const msg = mkMsg({
      content: "   ",
      channel: { id: CHANNEL_A, name: "test-a" },
    });
    const result = await captureMessage(ledger, msg, config, stubLlm);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_content");
  });
});
