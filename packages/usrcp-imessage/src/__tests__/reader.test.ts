/**
 * Reader pipeline tests for the iMessage adapter.
 *
 * Verified:
 *   - DM (isGroup=false): always triggers reply on incoming
 *   - Group (isGroup=true): only triggers on prefix; prefix stripped before LLM
 *   - Group without prefix: no reply
 *   - is_from_me (isUser=true): never triggers reply (capture path, not reply)
 *   - Non-allowlisted chat: no reply
 *   - Cross-chat context: system prompt includes activity from other chats
 *   - Agent reply recorded in ledger with intent=agent_reply
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import { buildSystemPrompt, composeAndReply } from "../reader.js";
import type { ImessageConfig } from "../config.js";
import type { LlmClient } from "../llm.js";

const USER_HANDLE = "+14155551234";
const CHAT_A_ID = "7";
const CHAT_A_GUID = "iMessage;-;chat-a-guid";
const CHAT_B_ID = "9";
const CHAT_B_GUID = "iMessage;-;chat-b-guid";

const config: ImessageConfig = {
  anthropic_api_key: "sk-ant-stub",
  user_handle: USER_HANDLE,
  allowlisted_chats: [CHAT_A_ID, CHAT_B_ID],
  prefix: "..u ",
};

const stubLlm: LlmClient = {
  async summarize() { return "[summary]"; },
  async reply() { return "stubbed reply from imessage agent"; },
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

let msgCounter = 0;
function mkMsg(
  chatId: string,
  chatGuid: string,
  content: string,
  overrides: Partial<CaptureMessage> = {}
): CaptureMessage {
  msgCounter++;
  return {
    id: `guid-${msgCounter}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author: { id: "+19995551234", isUser: false },
    chat: { id: chatId, guid: chatGuid, isGroup: false },
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-imessage-reader-"));
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
      mkMsg(CHAT_A_ID, CHAT_A_GUID, "I'm working on the USRCP iMessage adapter", {
        author: { id: USER_HANDLE, isUser: true },
      }),
      config,
      stubLlm
    );

    const prompt = buildSystemPrompt(ledger, CHAT_B_ID);
    expect(prompt).toContain("USRCP iMessage adapter");
    expect(prompt).toContain("imessage/communication");
  });

  it("separates chat-local events from global cross-chat events", async () => {
    await captureMessage(
      ledger,
      mkMsg(CHAT_A_ID, CHAT_A_GUID, "message in A about pancakes", {
        author: { id: USER_HANDLE, isUser: true },
      }),
      config, stubLlm
    );
    await captureMessage(
      ledger,
      mkMsg(CHAT_B_ID, CHAT_B_GUID, "message in B about waffles", {
        author: { id: USER_HANDLE, isUser: true },
      }),
      config, stubLlm
    );

    const promptForB = buildSystemPrompt(ledger, CHAT_B_ID);
    const [, channelSectionB] = promptForB.split(/Recent activity in THIS iMessage chat/);
    expect(channelSectionB).toContain("waffles");
    expect(channelSectionB).not.toContain("pancakes");
    expect(promptForB).toContain("pancakes"); // in global section

    const promptForA = buildSystemPrompt(ledger, CHAT_A_ID);
    const [, channelSectionA] = promptForA.split(/Recent activity in THIS iMessage chat/);
    expect(channelSectionA).toContain("pancakes");
    expect(channelSectionA).not.toContain("waffles");
  });
});

// ---------------------------------------------------------------------------
// DM trigger
// ---------------------------------------------------------------------------

describe("composeAndReply — DM (isGroup=false) always triggers reply", () => {
  it("replies to incoming DM without prefix required", async () => {
    const sent: string[] = [];
    const msg = mkMsg(CHAT_A_ID, CHAT_A_GUID, "hi what was I working on?", {
      author: { id: "+19995551234", isUser: false },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });

    const result = await composeAndReply(ledger, msg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(true);
    if (!result.replied) throw new Error("unreachable");
    expect(result.replyText).toBe("stubbed reply from imessage agent");
    expect(sent).toEqual(["stubbed reply from imessage agent"]);

    // Bot's own reply should be in the ledger with intent=agent_reply
    const timeline = ledger.getTimeline({ last_n: 10 });
    const botReply = timeline.find((e) => e.intent === "agent_reply");
    expect(botReply).toBeDefined();
    expect(botReply!.channel_id).toBe(CHAT_A_ID);
  });
});

// ---------------------------------------------------------------------------
// Group chat trigger
// ---------------------------------------------------------------------------

describe("composeAndReply — Group (isGroup=true) trigger model", () => {
  it("replies to group message WITH prefix; prefix is stripped before LLM", async () => {
    let capturedUserContent = "";
    const capturingLlm: LlmClient = {
      async summarize() { return "[summary]"; },
      async reply(_sys: string, userMsg: string) {
        capturedUserContent = userMsg;
        return "group reply";
      },
    };

    const sent: string[] = [];
    const msg = mkMsg(CHAT_A_ID, CHAT_A_GUID, "..u what did I work on today?", {
      author: { id: "+19995551234", isUser: false },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: true },
    });

    const result = await composeAndReply(ledger, msg, config, capturingLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(true);
    expect(sent).toHaveLength(1);
    // Prefix "..u " should be stripped; LLM sees only the user's question
    expect(capturedUserContent).toBe("what did I work on today?");
    expect(capturedUserContent).not.toContain("..u");
  });

  it("does NOT reply to group message WITHOUT prefix", async () => {
    const sent: string[] = [];
    const msg = mkMsg(CHAT_A_ID, CHAT_A_GUID, "hey everyone what's up?", {
      author: { id: "+19995551234", isUser: false },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: true },
    });

    const result = await composeAndReply(ledger, msg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("no_prefix");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// is_from_me: user's own messages should NOT trigger reply
// ---------------------------------------------------------------------------

describe("composeAndReply — is_from_me does not trigger reply", () => {
  it("does not reply when author.isUser is true", async () => {
    const sent: string[] = [];
    const msg = mkMsg(CHAT_A_ID, CHAT_A_GUID, "..u my own message", {
      author: { id: USER_HANDLE, isUser: true },
      chat: { id: CHAT_A_ID, guid: CHAT_A_GUID, isGroup: false },
    });

    const result = await composeAndReply(ledger, msg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("is_from_me");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-allowlisted chat
// ---------------------------------------------------------------------------

describe("composeAndReply — non-allowlisted chat", () => {
  it("does not reply in a chat not on the allowlist", async () => {
    const sent: string[] = [];
    const msg = mkMsg("UNLISTED-ID", "iMessage;-;unlisted", "..u hi", {
      author: { id: "+19995551234", isUser: false },
      chat: { id: "UNLISTED-ID", guid: "iMessage;-;unlisted", isGroup: false },
    });

    const result = await composeAndReply(ledger, msg, config, stubLlm, async (text) => {
      sent.push(text);
    });

    expect(result.replied).toBe(false);
    if (result.replied) throw new Error("unreachable");
    expect(result.reason).toBe("chat_not_allowlisted");
    expect(sent).toEqual([]);
  });
});
