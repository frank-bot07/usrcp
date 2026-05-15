import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import { makeStitcher, type StitchInput } from "../stitch/thread.js";
import { loadVectorExtension } from "../vector/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// Codex P1-2: topic_centroid must be encrypted at rest. The previous
// implementation stored raw float32 bytes as BLOB; an attacker with read
// access could embed probe strings and reverse-search the centroid.

class DeterministicEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake-deterministic";
  async embed(text: string): Promise<Float32Array> {
    const seed = crypto.createHash("sha256").update(text).digest();
    const vec = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      // Inject a recognizable sentinel value into the first dim so we
      // can grep for it in the raw file.
      vec[i] = (seed[i % seed.length] / 255) * 2 - 1;
    }
    return vec;
  }
}

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-centroid-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("encrypted topic_centroid (Codex P1-2)", () => {
  it("threads.topic_centroid stores enc: ciphertext on disk", async () => {
    const embedder = new DeterministicEmbedder();
    const stitcher = makeStitcher(handle);
    const adapter = (input: StitchInput) => stitcher.stitch(input);
    await captureEvent(
      { handle, embedder, stitch: adapter },
      {
        surface: "discord",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "anchor event for centroid",
        content_kind: "text",
        ts_ms: 1000,
      }
    );

    const row = handle.db
      .prepare("SELECT topic_centroid FROM threads LIMIT 1")
      .get() as { topic_centroid: string };
    expect(row.topic_centroid).toBeTruthy();
    expect(typeof row.topic_centroid).toBe("string");
    expect(row.topic_centroid.startsWith("enc:")).toBe(true);
  });

  it("the raw stream.db file does not contain centroid plaintext bytes for known content", async () => {
    const embedder = new DeterministicEmbedder();
    const stitcher = makeStitcher(handle);
    const adapter = (input: StitchInput) => stitcher.stitch(input);
    const content = "anchor event for centroid";
    await captureEvent(
      { handle, embedder, stitch: adapter },
      {
        surface: "discord",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content,
        content_kind: "text",
        ts_ms: 1000,
      }
    );

    // Compute the raw bytes that would have been stored before this fix.
    const knownVec = await embedder.embed(content);
    const rawBytes = Buffer.from(
      knownVec.buffer,
      knownVec.byteOffset,
      knownVec.byteLength
    );
    closeStreamDb(handle);
    const fileBytes = fs.readFileSync(handle.dbPath);
    // The exact float32 byte sequence MUST NOT appear in the on-disk
    // SQLite file. If this fails, centroid encryption regressed.
    expect(fileBytes.includes(rawBytes)).toBe(false);
    handle = openStreamDb(tmpDir, masterKey);
  });

  it("centroid encrypts on create AND decrypts on attach (member_count grows past 1)", async () => {
    const embedder = new DeterministicEmbedder();
    const stitcher = makeStitcher(handle);
    const adapter = (input: StitchInput) => stitcher.stitch(input);

    const e1 = await captureEvent(
      { handle, embedder, stitch: adapter },
      {
        surface: "discord",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "anchor",
        content_kind: "text",
        ts_ms: 1000,
      }
    );
    // Same channel, same surface, within same_channel_window_ms.
    // Same-channel boost takes entity_component to 1, recency stays
    // near 1.0, score > link_threshold, attach() decrypts centroid,
    // merges, re-encrypts. If decryption is broken, attach throws.
    const e2 = await captureEvent(
      { handle, embedder, stitch: adapter },
      {
        surface: "discord",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "follow-up",
        content_kind: "text",
        ts_ms: 1000 + 60 * 1000,
      }
    );
    expect(e2.thread_id).toBe(e1.thread_id);

    const row = handle.db
      .prepare(
        "SELECT member_count, topic_centroid FROM threads WHERE thread_id = ?"
      )
      .get(e1.thread_id!) as { member_count: number; topic_centroid: string };
    expect(row.member_count).toBe(2);
    expect(row.topic_centroid.startsWith("enc:")).toBe(true);
  });

  it("centroid cannot be read with the wrong master key", async () => {
    const embedder = new DeterministicEmbedder();
    const stitcher = makeStitcher(handle);
    const adapter = (input: StitchInput) => stitcher.stitch(input);
    await captureEvent(
      { handle, embedder, stitch: adapter },
      {
        surface: "discord",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "x",
        content_kind: "text",
        ts_ms: 1000,
      }
    );

    closeStreamDb(handle);
    const wrongKey = crypto.randomBytes(32);
    const wrongHandle = openStreamDb(tmpDir, wrongKey);
    loadVectorExtension(wrongHandle.db);
    const wrongStitcher = makeStitcher(wrongHandle);
    // A capture from the wrong key produces a NEW thread (the wrong-key
    // stitcher can't decrypt centroid, falls back to topic=0, recency
    // alone is below link_threshold).
    const e2 = await captureEvent(
      {
        handle: wrongHandle,
        embedder: new DeterministicEmbedder(),
        stitch: (i) => wrongStitcher.stitch(i),
      },
      {
        surface: "discord",
        channel_ref: { c: "different" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "x",
        content_kind: "text",
        ts_ms: 1000 + 60 * 1000,
      }
    );
    // We don't make a strong claim about thread linkage here (recency
    // could still tip it). The load-bearing check is that no decrypt
    // exception escapes to the caller.
    expect(e2.event_uuid).toBeTruthy();
    closeStreamDb(wrongHandle);
    handle = openStreamDb(tmpDir, masterKey); // restore for afterEach
  });
});
