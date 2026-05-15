import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import {
  decryptFromColumn,
  decryptJsonFromColumn,
} from "../db/encrypted-row.js";
import { loadVectorExtension } from "../vector/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// Deterministic fake embedder: pure function of input text. No network. The
// real Ollama embedder is exercised in vector-search.test.ts which is
// Ollama-gated.
class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake-deterministic";
  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dims);
    const seed = crypto
      .createHash("sha256")
      .update(text)
      .digest();
    for (let i = 0; i < this.dims; i++) {
      vec[i] = (seed[i % seed.length] / 255) * 2 - 1;
    }
    return vec;
  }
}

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-capture-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("capture-bidirectional", () => {
  it("captures inbound and outbound events on the same channel and decrypts both sides", async () => {
    const channel = { guild: "g1", channel: "c1" };
    const ts = Date.now();

    const inbound = await captureEvent(
      { handle, embedder: null },
      {
        surface: "discord",
        channel_ref: channel,
        side: "inbound",
        author_ref: { id: "user-a", displayName: "Alice" },
        content: "hey, anyone awake?",
        content_kind: "text",
        ts_ms: ts,
      }
    );

    const outbound = await captureEvent(
      { handle, embedder: null },
      {
        surface: "discord",
        channel_ref: channel,
        side: "outbound",
        author_ref: { id: "user-b", displayName: "Bot" },
        content: "yep, what's up?",
        content_kind: "text",
        ts_ms: ts + 1000,
      }
    );

    expect(inbound.event_uuid).toBeTruthy();
    expect(outbound.event_uuid).toBeTruthy();
    expect(inbound.event_uuid).not.toBe(outbound.event_uuid);

    const rows = handle.db
      .prepare("SELECT event_uuid, side, author_ref, content, channel_ref FROM events ORDER BY ts_ms ASC")
      .all() as { event_uuid: string; side: string; author_ref: string; content: string; channel_ref: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0].side).toBe("inbound");
    expect(rows[1].side).toBe("outbound");

    // Both sides decrypt back to their original payloads.
    const author0 = decryptJsonFromColumn<{ id: string; displayName: string }>(masterKey, "events", rows[0].author_ref);
    const author1 = decryptJsonFromColumn<{ id: string; displayName: string }>(masterKey, "events", rows[1].author_ref);
    expect(author0.displayName).toBe("Alice");
    expect(author1.displayName).toBe("Bot");

    expect(decryptFromColumn(masterKey, "events", rows[0].content)).toBe("hey, anyone awake?");
    expect(decryptFromColumn(masterKey, "events", rows[1].content)).toBe("yep, what's up?");

    // Channel ref encrypted column matches input on both sides.
    expect(decryptJsonFromColumn(masterKey, "events", rows[0].channel_ref)).toEqual(channel);
    expect(decryptJsonFromColumn(masterKey, "events", rows[1].channel_ref)).toEqual(channel);
  });

  it("rejects malformed events at the schema boundary", async () => {
    await expect(
      captureEvent(
        { handle, embedder: null },
        {
          surface: "discord",
          channel_ref: { c: "x" },
          side: "sideways",  // invalid enum
          author_ref: { id: "u1" },
          content: "x",
          content_kind: "text",
          ts_ms: Date.now(),
        }
      )
    ).rejects.toThrow();
  });

  it("attaches an embedding row when an embedder is configured", async () => {
    const embedder = new FakeEmbedder();
    const result = await captureEvent(
      { handle, embedder },
      {
        surface: "telegram",
        channel_ref: { chatId: 123 },
        side: "inbound",
        author_ref: { id: "u1", displayName: "Anon" },
        content: "test embedding pipeline",
        content_kind: "text",
        ts_ms: Date.now(),
      }
    );

    expect(result.event_uuid).toBeTruthy();
    const row = handle.db
      .prepare("SELECT embedding_id FROM events WHERE event_uuid = ?")
      .get(result.event_uuid) as { embedding_id: number | null };
    expect(row.embedding_id).not.toBeNull();

    const emb = handle.db
      .prepare("SELECT dims, model FROM embeddings WHERE id = ?")
      .get(row.embedding_id) as { dims: number; model: string };
    expect(emb.dims).toBe(64);
    expect(emb.model).toBe("fake-deterministic");
  });

  it("upserts surface_state on every capture (presence baseline)", async () => {
    const surface = "discord";
    await captureEvent(
      { handle, embedder: null },
      {
        surface,
        channel_ref: { guild: "g1", channel: "c1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "first",
        content_kind: "text",
        ts_ms: 1000,
      }
    );
    await captureEvent(
      { handle, embedder: null },
      {
        surface,
        channel_ref: { guild: "g2", channel: "c2" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "second",
        content_kind: "text",
        ts_ms: 2000,
      }
    );

    const state = handle.db
      .prepare("SELECT surface, channel_ref, last_seen_ms FROM surface_state WHERE surface = ?")
      .get(surface) as { surface: string; channel_ref: string; last_seen_ms: number };
    expect(state.last_seen_ms).toBe(2000);
    expect(decryptJsonFromColumn(masterKey, "surface_state", state.channel_ref)).toEqual({ guild: "g2", channel: "c2" });
  });
});
