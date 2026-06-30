import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Ledger } from "usrcp-core/ledger";
import { setUserSlug } from "usrcp-core/encryption";
import { createStreamCaptureClient } from "usrcp-stream/dist/capture-client.js";
import type { EmbeddingProvider } from "usrcp-stream/dist/embeddings/provider.js";
import { captureMessageToStream } from "../stream-capture.js";
import { captureMessage, type CaptureMessage } from "../capture.js";
import type { DiscordConfig } from "../config.js";
import type { LlmClient } from "../llm.js";
import { resolveMode } from "../index.js";

const stubLlm: LlmClient = {
  async summarize() { return "[summary]"; },
  async reply() { return "[reply]"; },
};

class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake";
  async embed(text: string): Promise<Float32Array> {
    const h = crypto.createHash("sha256").update(text).digest();
    const v = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) v[i] = (h[i % h.length] / 255) * 2 - 1;
    return v;
  }
}

const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const CHANNEL_A = "ch_a";
const CHANNEL_UNLISTED = "ch_x";

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let streamClient: ReturnType<typeof createStreamCaptureClient>;

const config: DiscordConfig = {
  discord_bot_token: "stub",
  anthropic_api_key: "stub",
  allowlisted_channels: [CHANNEL_A],
  user_id: USER_ID,
};

function mkMsg(overrides: Partial<CaptureMessage> & { channel: CaptureMessage["channel"] }): CaptureMessage {
  return {
    id: "msg_" + Math.random().toString(36).slice(2, 10),
    content: "hi",
    author: { id: USER_ID, bot: false, displayName: "Frank" },
    guild: { id: "g1", name: "guild" },
    thread: null,
    ts_ms: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-discord-stream-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  ledger = new Ledger(path.join(tmpHome, "ledger.db"));
  streamClient = createStreamCaptureClient(ledger.getMasterKey(), tmpHome, {
    ledger,
    embedder: new FakeEmbedder(),
  });
});

afterEach(() => {
  try { streamClient.close(); } catch { /* */ }
  try { ledger.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("Discord stream-capture filtering", () => {
  it("captures inbound (other human) on allowlisted channel with side='inbound'", async () => {
    const msg = mkMsg({
      content: "incoming from Alice",
      author: { id: OTHER_USER_ID, bot: false, displayName: "Alice" },
      channel: { id: CHANNEL_A, name: "general" },
    });
    const r = await captureMessageToStream(streamClient, msg, config);
    expect(r.captured).toBe(true);
    if (r.captured) {
      expect(r.side).toBe("inbound");
      expect(r.event_uuid).toBeTruthy();
    }
  });

  it("captures outbound (user's own) on allowlisted channel with side='outbound'", async () => {
    const msg = mkMsg({
      content: "self-message",
      author: { id: USER_ID, bot: false, displayName: "Frank" },
      channel: { id: CHANNEL_A, name: "general" },
    });
    const r = await captureMessageToStream(streamClient, msg, config);
    expect(r.captured).toBe(true);
    if (r.captured) {
      expect(r.side).toBe("outbound");
    }
  });

  it("skips bot messages on any channel", async () => {
    const msg = mkMsg({
      content: "I am a bot",
      author: { id: "bot-1", bot: true },
      channel: { id: CHANNEL_A, name: "general" },
    });
    const r = await captureMessageToStream(streamClient, msg, config);
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("bot_author");
  });

  it("skips messages on non-allowlisted channels even from the user", async () => {
    const msg = mkMsg({
      content: "off-channel",
      channel: { id: CHANNEL_UNLISTED, name: "off" },
    });
    const r = await captureMessageToStream(streamClient, msg, config);
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("channel_not_allowlisted");
  });

  it("skips empty messages", async () => {
    const msg = mkMsg({ content: "   ", channel: { id: CHANNEL_A, name: "general" } });
    const r = await captureMessageToStream(streamClient, msg, config);
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("empty_content");
  });

  it("ledger and stream see different sets: ledger user-only, stream both sides", async () => {
    const inbound = mkMsg({
      content: "alice typing",
      author: { id: OTHER_USER_ID, bot: false, displayName: "Alice" },
      channel: { id: CHANNEL_A, name: "general" },
    });
    const outbound = mkMsg({
      content: "frank replying",
      author: { id: USER_ID, bot: false, displayName: "Frank" },
      channel: { id: CHANNEL_A, name: "general" },
    });

    // Both messages run through both paths, like --mode=both at runtime.
    await captureMessage(ledger, inbound, config, stubLlm);
    await captureMessage(ledger, outbound, config, stubLlm);
    await captureMessageToStream(streamClient, inbound, config);
    await captureMessageToStream(streamClient, outbound, config);

    // Ledger has only the user's own message (existing user-only filter).
    const ledgerCount = ledger.getStats().total_events;
    expect(ledgerCount).toBe(1);

    // Stream has both.
    const streamCount = streamClient.handle.db
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    expect(streamCount.c).toBe(2);

    // The two stream events have different sides.
    const sides = streamClient.handle.db
      .prepare("SELECT side FROM events ORDER BY ts_ms ASC")
      .all() as { side: string }[];
    expect(new Set(sides.map((s) => s.side))).toEqual(new Set(["inbound", "outbound"]));
  });
});

describe("resolveMode dispatch", () => {
  it("explicit --mode wins when stream is installed", () => {
    expect(resolveMode("ledger", true)).toBe("ledger");
    expect(resolveMode("stream", true)).toBe("stream");
    expect(resolveMode("both", true)).toBe("both");
  });

  it("no flag + stream installed -> both", () => {
    expect(resolveMode(undefined, true)).toBe("both");
  });

  it("no flag + stream missing -> ledger", () => {
    expect(resolveMode(undefined, false)).toBe("ledger");
  });

  it("--mode ledger always works (no stream dependency)", () => {
    expect(resolveMode("ledger", false)).toBe("ledger");
    expect(resolveMode("ledger", true)).toBe("ledger");
  });

  it("--mode stream throws when usrcp-stream is not installed", () => {
    expect(() => resolveMode("stream", false)).toThrow(/usrcp-stream to be installed/);
  });

  it("--mode both throws when usrcp-stream is not installed", () => {
    expect(() => resolveMode("both", false)).toThrow(/usrcp-stream to be installed/);
  });

  it("invalid --mode throws", () => {
    expect(() => resolveMode("garbage", true)).toThrow();
  });
});
