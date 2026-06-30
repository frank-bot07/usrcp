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
import type { ImessageConfig } from "../config.js";
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

const USER_HANDLE = "+15551112222";
const CHAT_A = "1";
const CHAT_UNLISTED = "999";

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let streamClient: ReturnType<typeof createStreamCaptureClient>;

const config: ImessageConfig = {
  anthropic_api_key: "stub",
  allowlisted_chats: [CHAT_A],
  user_handle: USER_HANDLE,
  prefix: "..u ",
};

function mkMsg(overrides: Partial<CaptureMessage> & { chat: CaptureMessage["chat"] }): CaptureMessage {
  return {
    id: `guid-${Math.random().toString(36).slice(2, 8)}`,
    content: "hi",
    author: { id: USER_HANDLE, isUser: true },
    ts_ms: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-imessage-stream-"));
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

describe("iMessage stream-capture filtering", () => {
  it("captures incoming (other party) with side='inbound'", async () => {
    const r = await captureMessageToStream(
      streamClient,
      mkMsg({
        content: "Alice typing",
        author: { id: "+19995551234", isUser: false, displayName: "Alice" },
        chat: { id: CHAT_A, guid: "iMessage;-;chat1", isGroup: false },
      }),
      config
    );
    expect(r.captured).toBe(true);
    if (r.captured) expect(r.side).toBe("inbound");
  });

  it("captures user-sent (is_from_me) with side='outbound'", async () => {
    const r = await captureMessageToStream(
      streamClient,
      mkMsg({ chat: { id: CHAT_A, guid: "iMessage;-;chat1", isGroup: false } }),
      config
    );
    expect(r.captured).toBe(true);
    if (r.captured) expect(r.side).toBe("outbound");
  });

  it("skips non-allowlisted chats", async () => {
    const r = await captureMessageToStream(
      streamClient,
      mkMsg({ chat: { id: CHAT_UNLISTED, guid: "iMessage;-;off", isGroup: false } }),
      config
    );
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("chat_not_allowlisted");
  });

  it("skips empty messages", async () => {
    const r = await captureMessageToStream(
      streamClient,
      mkMsg({ content: "  ", chat: { id: CHAT_A, guid: "iMessage;-;chat1", isGroup: false } }),
      config
    );
    expect(r.captured).toBe(false);
    if (!r.captured) expect(r.reason).toBe("empty_content");
  });

  it("ledger gets only is_from_me, stream gets both sides", async () => {
    const inbound = mkMsg({
      content: "Alice",
      author: { id: "+19995551234", isUser: false, displayName: "Alice" },
      chat: { id: CHAT_A, guid: "iMessage;-;chat1", isGroup: false },
    });
    const outbound = mkMsg({
      content: "Frank",
      chat: { id: CHAT_A, guid: "iMessage;-;chat1", isGroup: false },
    });
    await captureMessage(ledger, inbound, config, stubLlm);
    await captureMessage(ledger, outbound, config, stubLlm);
    await captureMessageToStream(streamClient, inbound, config);
    await captureMessageToStream(streamClient, outbound, config);

    expect(ledger.getStats().total_events).toBe(1);
    const streamCount = streamClient.handle.db
      .prepare("SELECT COUNT(*) as c FROM events")
      .get() as { c: number };
    expect(streamCount.c).toBe(2);
  });
});

describe("resolveMode dispatch (iMessage)", () => {
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
  it("--mode ledger always works", () => {
    expect(resolveMode("ledger", false)).toBe("ledger");
  });
  it("--mode stream throws when usrcp-stream not installed", () => {
    expect(() => resolveMode("stream", false)).toThrow(/usrcp-stream to be installed/);
  });
  it("--mode both throws when usrcp-stream not installed", () => {
    expect(() => resolveMode("both", false)).toThrow(/usrcp-stream to be installed/);
  });
  it("invalid --mode throws", () => {
    expect(() => resolveMode("garbage", true)).toThrow();
  });
});
