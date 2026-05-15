import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  createStreamCaptureClient,
  type StreamCaptureClient,
} from "../capture-client.js";
import { decryptFromColumn } from "../db/encrypted-row.js";
import { saveConfig } from "../config-io.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake-deterministic";
  async embed(text: string): Promise<Float32Array> {
    const seed = crypto.createHash("sha256").update(text).digest();
    const vec = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      vec[i] = (seed[i % seed.length] / 255) * 2 - 1;
    }
    return vec;
  }
}

let tmpDir: string;
let masterKey: Buffer;
let client: StreamCaptureClient;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-cc-"));
  masterKey = crypto.randomBytes(32);
});

afterEach(() => {
  try { client?.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createStreamCaptureClient", () => {
  it("capture() round-trips an event into stream.db with encrypted content", async () => {
    client = createStreamCaptureClient(masterKey, tmpDir, {
      embedder: new FakeEmbedder(),
    });
    const ev = await client.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1", displayName: "Alice" },
      content: "hello via capture-client",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    expect(ev.event_uuid).toBeTruthy();
    expect(ev.thread_id).toBeTruthy();
    const row = client.handle.db
      .prepare("SELECT content FROM events WHERE event_uuid = ?")
      .get(ev.event_uuid) as { content: string };
    expect(row.content.startsWith("enc:")).toBe(true);
    expect(decryptFromColumn(masterKey, "events", row.content)).toBe(
      "hello via capture-client"
    );
  });

  it("explicit embedder: null disables vector writes", async () => {
    client = createStreamCaptureClient(masterKey, tmpDir, {
      embedder: null,
    });
    const ev = await client.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "no embedder",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const embRow = client.handle.db
      .prepare("SELECT COUNT(*) as c FROM embeddings")
      .get() as { c: number };
    expect(embRow.c).toBe(0);
    expect(ev.event_uuid).toBeTruthy();
  });

  it("omitted embedder auto-loads from saved stream-config.toml", async () => {
    // Seed a config pointing at a deliberately-invalid host so the load
    // path is exercised but the network call fails deterministically
    // (regardless of whether real Ollama is running on this machine).
    // Capture throwing during embed() proves the embedder was
    // constructed - an embedder:null client would not throw, it would
    // skip the embed step and write the event row.
    saveConfig(masterKey, tmpDir, {
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
        // Port 1 (TCP/ICMP control) is reserved; connections refuse fast.
        host: "http://127.0.0.1:1",
      },
    });
    client = createStreamCaptureClient(masterKey, tmpDir);
    await expect(
      client.capture({
        surface: "discord",
        channel_ref: { c: "x" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "probe",
        content_kind: "text",
        ts_ms: Date.now(),
      })
    ).rejects.toThrow();
  });

  it("no saved config + omitted embedder yields a null-embedder client (no throw, no embed)", async () => {
    client = createStreamCaptureClient(masterKey, tmpDir);
    const ev = await client.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "no config",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const embRow = client.handle.db
      .prepare("SELECT COUNT(*) as c FROM embeddings")
      .get() as { c: number };
    expect(embRow.c).toBe(0);
    expect(ev.event_uuid).toBeTruthy();
  });

  it("close() makes subsequent capture calls fail (DB closed)", async () => {
    client = createStreamCaptureClient(masterKey, tmpDir, { embedder: null });
    client.close();
    await expect(
      client.capture({
        surface: "discord",
        channel_ref: { c: "x" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "x",
        content_kind: "text",
        ts_ms: Date.now(),
      })
    ).rejects.toThrow();
  });

  it("stitches the same thread across two events on the same channel within window", async () => {
    client = createStreamCaptureClient(masterKey, tmpDir, { embedder: null });
    const base = 1_700_000_000_000;
    const e1 = await client.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "first",
      content_kind: "text",
      ts_ms: base,
    });
    const e2 = await client.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "second",
      content_kind: "text",
      ts_ms: base + 60 * 1000,
    });
    expect(e2.thread_id).toBe(e1.thread_id);
  });
});
