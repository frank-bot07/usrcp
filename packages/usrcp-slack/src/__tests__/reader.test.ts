/**
 * Reader pipeline tests for the Slack adapter.
 *
 * Exercises cross-channel context assembly, DM triggering, app_mention
 * triggering, thread_ts preservation, and non-allowlisted channel rejection.
 *
 * No live Bolt WebSocket or Anthropic API calls — all are stubbed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import { buildSystemPrompt, composeAndReply } from "../reader.js";
import type { SlackConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const USER_ID = "U01234567890";
const CHANNEL_A = "C01234567890";
const CHANNEL_B = "C09876543210";
const TEAM_ID = "T01234567890";

const config: SlackConfig = {
  slack_bot_token: "xoxb-stub",
  slack_app_token: "xapp-stub",
  anthropic_api_key: "sk-ant-stub",
  allowlisted_channels: [CHANNEL_A, CHANNEL_B],
  user_id: USER_ID,
};

const stubLlm: LlmClient = {
  async summarize() { return "[summary]"; },
  async reply() { return "stubbed reply from slack agent"; },
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

function mkMsg(ch: { id: string; name?: string }, content: string, overrides: Partial<CaptureMessage> = {}): CaptureMessage {
  return {
    id: `ts_${Math.random().toString(36).slice(2, 10)}`,
    content,
    author: { id: USER_ID, bot: false },
    channel: ch,
    thread: null,
    team_id: TEAM_ID,
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-slack-reader-"));
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
// buildSystemPrompt — cross-channel context assembly
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — cross-channel context assembly", () => {
  it("includes activity from channel A in the prompt when composing a reply for channel B", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "engineering" }, "I'm working on the USRCP slack adapter"),
      config,
      stubLlm
    );

    const prompt = buildSystemPrompt(ledger, CHANNEL_B);
    expect(prompt).toContain("USRCP slack adapter");
    expect(prompt).toContain("slack/communication");
  });

  it("separates channel-local events from global cross-channel events", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "engineering" }, "message in A about pancakes"),
      config, stubLlm
    );
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_B, name: "design" }, "message in B about waffles"),
      config, stubLlm
    );

    const promptForB = buildSystemPrompt(ledger, CHANNEL_B);
    const [, channelSectionB] = promptForB.split(/Recent activity in THIS Slack channel/);
    expect(channelSectionB).toContain("waffles");
    expect(channelSectionB).not.toContain("pancakes");
    expect(promptForB).toContain("pancakes"); // in global section

    const promptForA = buildSystemPrompt(ledger, CHANNEL_A);
    const [, channelSectionA] = promptForA.split(/Recent activity in THIS Slack channel/);
    expect(channelSectionA).toContain("pancakes");
    expect(channelSectionA).not.toContain("waffles");
  });
});

// ---------------------------------------------------------------------------
// composeAndReply — app_mention
// ---------------------------------------------------------------------------

describe("composeAndReply — app_mention triggers reply", () => {
  it("calls LLM, sends reply, and records the bot reply as an event", async () => {
    // Seed prior context
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "engineering" }, "context: building slack adapter"),
      config, stubLlm
    );

    const sent: string[] = [];
    const mention = mkMsg({ id: CHANNEL_B, name: "design" }, "what was I just doing?");

    const result = await composeAndReply(ledger, mention, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(true);
    if (!result.replied) throw new Error("unreachable");
    expect(result.replyText).toBe("stubbed reply from slack agent");
    expect(sent).toEqual(["stubbed reply from slack agent"]);

    // Bot's own reply should be in the ledger with intent=agent_reply
    const timeline = ledger.getTimeline({ last_n: 10 });
    const botReply = timeline.find((e) => e.intent === "agent_reply");
    expect(botReply).toBeDefined();
    expect(botReply!.channel_id).toBe(CHANNEL_B);
  });

  it("does not reply in non-allowlisted channels", async () => {
    const sent: string[] = [];
    const mention = mkMsg({ id: "C_UNLISTED", name: "nope" }, "@bot hi");

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
// DM (channel_type "im") triggers reply
// ---------------------------------------------------------------------------

describe("DM channel triggers reply", () => {
  it("replies to a DM when the channel is in the allowlist (as added by index.ts for DMs)", async () => {
    // index.ts adds the DM channel to the allowlist temporarily before calling composeAndReply.
    // Simulate that here by using a channel that IS in the allowlist.
    const sent: string[] = [];
    const dmMsg = mkMsg({ id: CHANNEL_A }, "dm message to bot");

    const result = await composeAndReply(ledger, dmMsg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(true);
    if (!result.replied) throw new Error("unreachable");
    expect(sent).toHaveLength(1);
  });

  it("skips reply for DM from non-configured user (bot author check)", async () => {
    const sent: string[] = [];
    const dmMsg = mkMsg({ id: CHANNEL_A }, "someone else's DM", {
      author: { id: "U_OTHER", bot: false },
    });

    // Note: composeAndReply doesn't check user_id — that's done in index.ts.
    // But it does check author.bot. Let's verify the bot_author path:
    const botMsg = mkMsg({ id: CHANNEL_A }, "bot's own DM", {
      author: { id: USER_ID, bot: true },
    });

    const result = await composeAndReply(ledger, botMsg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("bot_author");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// thread_ts preservation
// ---------------------------------------------------------------------------

describe("thread_ts preservation", () => {
  it("preserves thread_id through to the ledger event for captured messages", async () => {
    const THREAD_TS = "1700000000.123456";
    const msg = mkMsg(
      { id: CHANNEL_A, name: "engineering" },
      "reply in a Slack thread",
      { thread: { id: THREAD_TS } }
    );

    await captureMessage(ledger, msg, config, stubLlm);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events.length).toBe(1);
    expect(events[0].thread_id).toBe(THREAD_TS);
  });

  it("preserves thread_ts on the bot reply event when composeAndReply is called with a threaded message", async () => {
    const THREAD_TS = "1700000000.654321";
    const mention = mkMsg(
      { id: CHANNEL_A, name: "engineering" },
      "@bot what was I doing?",
      { thread: { id: THREAD_TS } }
    );

    await composeAndReply(ledger, mention, config, stubLlm, async () => { /* noop */ });

    const events = ledger.getTimeline({ last_n: 10 });
    const agentReply = events.find((e) => e.intent === "agent_reply");
    expect(agentReply).toBeDefined();
    expect(agentReply!.thread_id).toBe(THREAD_TS);
  });
});
