/**
 * Reader pipeline tests.
 *
 * These exercise the cross-channel context assembly that criterion 2
 * depends on — i.e. the LOGIC that "a mention in channel B pulls content
 * from channel A" is correct, without requiring a live Discord gateway
 * or Anthropic API call. The end-to-end live demo with a real bot is
 * documented in DEMO.md as criterion 2's manual checklist.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-local/dist/ledger.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import { buildSystemPrompt, composeAndReply } from "../reader.js";
import type { DiscordConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const USER_ID = "user_42";
const CHANNEL_A = "ch_a";
const CHANNEL_B = "ch_b";

const config: DiscordConfig = {
  discord_bot_token: "stub",
  anthropic_api_key: "stub",
  allowlisted_channels: [CHANNEL_A, CHANNEL_B],
  user_id: USER_ID,
};

const stubLlm: LlmClient = {
  async summarize() {
    return "[summary]";
  },
  async reply() {
    return "stubbed reply from agent";
  },
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

function mkMsg(ch: { id: string; name?: string }, content: string): CaptureMessage {
  return {
    id: "msg_" + Math.random().toString(36).slice(2, 10),
    content,
    author: { id: USER_ID, bot: false },
    channel: ch,
    guild: { id: "guild_1", name: "g" },
    thread: null,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-discord-reader-"));
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

describe("buildSystemPrompt — cross-channel context assembly", () => {
  it("includes activity from channel A in the prompt when composing a reply for channel B", async () => {
    // Simulate the user posting in #channel-A
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "test-a" }, "I'm working on the USRCP discord adapter"),
      config,
      stubLlm
    );

    // Now build the prompt for a reply in #channel-B
    const prompt = buildSystemPrompt(ledger, CHANNEL_B);

    // The channel-A content must appear in the "all platforms recently"
    // section of the prompt (it's not in channel B's channel-local list,
    // but it IS in the global timeline).
    expect(prompt).toContain("USRCP discord adapter");
    expect(prompt).toContain("discord/communication");
  });

  it("separates channel-local events from global cross-channel events", async () => {
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "test-a" }, "message in channel A about pancakes"),
      config,
      stubLlm
    );
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_B, name: "test-b" }, "message in channel B about waffles"),
      config,
      stubLlm
    );

    // Prompt for channel B should contain the channel-B section with the
    // waffles message, and both messages in the global section.
    const promptForB = buildSystemPrompt(ledger, CHANNEL_B);
    const [, channelSectionB] = promptForB.split(/Recent activity in THIS Discord channel/);
    expect(channelSectionB).toContain("waffles");
    expect(channelSectionB).not.toContain("pancakes");
    expect(promptForB).toContain("pancakes"); // in global section

    // Inverse for channel A
    const promptForA = buildSystemPrompt(ledger, CHANNEL_A);
    const [, channelSectionA] = promptForA.split(/Recent activity in THIS Discord channel/);
    expect(channelSectionA).toContain("pancakes");
    expect(channelSectionA).not.toContain("waffles");
  });
});

describe("composeAndReply", () => {
  it("calls LLM, sends reply, and records the bot's own reply as an event", async () => {
    // Seed prior context
    await captureMessage(
      ledger,
      mkMsg({ id: CHANNEL_A, name: "test-a" }, "context: building discord adapter"),
      config,
      stubLlm
    );

    const sent: string[] = [];
    const mention = mkMsg({ id: CHANNEL_B, name: "test-b" }, "what was I just doing?");

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
    expect(botReply!.channel_id).toBe(CHANNEL_B);
  });

  it("does not reply in non-allowlisted channels", async () => {
    const sent: string[] = [];
    const mention = mkMsg({ id: "ch_unlisted", name: "nope" }, "@bot hi");

    const result = await composeAndReply(ledger, mention, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("channel_not_allowlisted");
    expect(sent).toEqual([]);
  });
});
