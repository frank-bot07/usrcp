/**
 * Reader pipeline tests — Telegram adapter.
 *
 * These exercise:
 *   - Cross-chat context assembly (a mention in chat B pulls context from chat A)
 *   - Mention detection logic (text @mention, text_mention entity, reply-to-bot, DM)
 *   - Plain group message without trigger does NOT fire composeAndReply
 *   - Bot reply is persisted back to ledger with intent=agent_reply
 *   - Non-allowlisted chat is rejected
 *
 * No real Telegram credentials are used. Bot shape is mocked with plain
 * objects. The shouldReply function is tested indirectly via index.ts's
 * toCaptureMessage path — here we test the capture+reader integration
 * directly using the narrow CaptureMessage interface.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import { buildSystemPrompt, composeAndReply } from "../reader.js";
import type { TelegramConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const USER_ID = "111222333";
const CHAT_A = "-1001234567890";
const CHAT_B = "-1009876543210";

const config: TelegramConfig = {
  telegram_bot_token: "stub-token",
  anthropic_api_key: "stub-key",
  allowlisted_chats: [CHAT_A, CHAT_B],
  user_id: USER_ID,
};

const stubLlm: LlmClient = {
  async summarize() { return "[summary]"; },
  async reply() { return "stubbed reply from agent"; },
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

function mkMsg(ch: { id: string; name?: string }, content: string, overrides: Partial<CaptureMessage> = {}): CaptureMessage {
  return {
    id: String(Math.floor(Math.random() * 1_000_000)),
    content,
    author: { id: USER_ID, bot: false },
    channel: ch,
    thread: null,
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-telegram-reader-"));
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
// buildSystemPrompt — cross-chat context assembly
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — cross-chat context assembly", () => {
  it("includes activity from chat A in the prompt when composing for chat B", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHAT_A, name: "group-a" }, "I'm working on the USRCP telegram adapter"),
      config,
      stubLlm
    );

    const prompt = buildSystemPrompt(ledger, CHAT_B);

    // The chat-A content must appear in the global timeline section
    expect(prompt).toContain("USRCP telegram adapter");
    expect(prompt).toContain("telegram/telegram");
  });

  it("separates chat-local events from global cross-chat events", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHAT_A, name: "group-a" }, "message in chat A about pancakes"),
      config,
      stubLlm
    );
    await captureMessage(
      ledger,
      mkMsg({ id: CHAT_B, name: "group-b" }, "message in chat B about waffles"),
      config,
      stubLlm
    );

    const promptForB = buildSystemPrompt(ledger, CHAT_B);
    const [, chatSectionB] = promptForB.split(/Recent activity in THIS Telegram chat/);
    expect(chatSectionB).toContain("waffles");
    expect(chatSectionB).not.toContain("pancakes");
    expect(promptForB).toContain("pancakes"); // in global section

    const promptForA = buildSystemPrompt(ledger, CHAT_A);
    const [, chatSectionA] = promptForA.split(/Recent activity in THIS Telegram chat/);
    expect(chatSectionA).toContain("pancakes");
    expect(chatSectionA).not.toContain("waffles");
  });
});

// ---------------------------------------------------------------------------
// composeAndReply
// ---------------------------------------------------------------------------

describe("composeAndReply", () => {
  it("calls LLM, sends reply, and records the bot's own reply as an event", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHAT_A, name: "group-a" }, "context: building telegram adapter"),
      config,
      stubLlm
    );

    const sent: string[] = [];
    const mention = mkMsg({ id: CHAT_B, name: "group-b" }, "what was I just doing?");

    const result = await composeAndReply(ledger, mention, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(true);
    if (!result.replied) throw new Error("unreachable");
    expect(result.replyText).toBe("stubbed reply from agent");
    expect(sent).toEqual(["stubbed reply from agent"]);

    // The bot's own reply is now in the ledger with intent=agent_reply
    const timeline = ledger.getTimeline({ last_n: 10 });
    const botReply = timeline.find((e) => e.intent === "agent_reply");
    expect(botReply).toBeDefined();
    expect(botReply!.channel_id).toBe(CHAT_B);
  });

  it("does not reply in non-allowlisted chats", async () => {
    const sent: string[] = [];
    const mention = mkMsg({ id: "-1009999999999", name: "off-limits" }, "@bot hi");

    const result = await composeAndReply(ledger, mention, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("channel_not_allowlisted");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mention detection logic
// These tests mirror the shouldReply() function in index.ts exactly,
// so any changes to that function must also update these tests.
// ---------------------------------------------------------------------------

describe("mention detection logic", () => {
  const BOT_ID = 987654321;
  const BOT_USERNAME = "usrcp_test_bot";

  /**
   * Mirrors shouldReply() from index.ts. Defined inline so tests don't
   * import the full bot entry point (which would try to connect).
   */
  function shouldReply(
    chatType: "private" | "group" | "supergroup" | "channel",
    text: string,
    entities: Array<{ type: string; offset: number; length: number; user?: { id: number } }>,
    replyToFromId?: number
  ): boolean {
    if (chatType === "private") return true;

    for (const e of entities) {
      if (e.type === "mention") {
        const mentioned = text.slice(e.offset, e.offset + e.length);
        if (mentioned === `@${BOT_USERNAME}`) return true;
      }
      if (e.type === "text_mention" && e.user?.id === BOT_ID) return true;
    }

    if (replyToFromId === BOT_ID) return true;

    return false;
  }

  it("DM (private chat) always triggers reply", () => {
    expect(shouldReply("private", "hello", [])).toBe(true);
  });

  it("@username text mention triggers reply", () => {
    const text = `@${BOT_USERNAME} what was I doing?`;
    const entities = [{ type: "mention", offset: 0, length: BOT_USERNAME.length + 1 }];
    expect(shouldReply("supergroup", text, entities)).toBe(true);
  });

  it("text_mention entity with bot's user.id triggers reply", () => {
    const entities = [{ type: "text_mention", offset: 0, length: 4, user: { id: BOT_ID } }];
    expect(shouldReply("supergroup", "hey you", entities)).toBe(true);
  });

  it("text_mention entity with a DIFFERENT user.id does NOT trigger reply", () => {
    const entities = [{ type: "text_mention", offset: 0, length: 4, user: { id: 11111 } }];
    expect(shouldReply("supergroup", "hey you", entities)).toBe(false);
  });

  it("reply-to-bot triggers reply", () => {
    expect(shouldReply("supergroup", "thanks!", [], BOT_ID)).toBe(true);
  });

  it("reply-to-different-user does NOT trigger reply", () => {
    expect(shouldReply("supergroup", "thanks!", [], 55555)).toBe(false);
  });

  it("plain group message without any trigger does NOT trigger reply", () => {
    expect(shouldReply("group", "just chatting", [])).toBe(false);
  });

  it("mention of a different bot username does NOT trigger reply", () => {
    const text = "@some_other_bot hello";
    const entities = [{ type: "mention", offset: 0, length: 15 }];
    expect(shouldReply("supergroup", text, entities)).toBe(false);
  });
});
