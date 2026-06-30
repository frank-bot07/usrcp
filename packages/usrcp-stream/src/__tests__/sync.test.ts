import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Ledger } from "usrcp-core/ledger";
import { setUserSlug } from "usrcp-core/encryption";
import { createStreamCaptureClient } from "../capture-client.js";
import {
  syncStreamPush,
  syncStreamPull,
  syncStreamStatus,
} from "../sync.js";
import {
  encryptEmbeddingForSync,
  decryptEmbeddingFromSync,
} from "../db/encrypted-row.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

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

interface CapturedRequest {
  method: string;
  url: string;
  body?: string;
}

function makeFakeFetch(handler: (req: Request) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? String(init.body) : undefined;
    requests.push({ method, url, body });
    const req = new Request(url, init);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let streamClient: ReturnType<typeof createStreamCaptureClient>;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-sync-"));
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

describe("embedding sync helpers (roundtrip via stream-embeddings)", () => {
  it("encryptEmbeddingForSync produces enc: ciphertext that decryptEmbeddingFromSync inverts", () => {
    const mk = crypto.randomBytes(32);
    const vec = new Float32Array([1, -2, 0.5, 100, -0.0001]);
    const ct = encryptEmbeddingForSync(mk, vec);
    expect(ct.startsWith("enc:")).toBe(true);
    const back = decryptEmbeddingFromSync(mk, ct);
    expect(back.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i++) expect(back[i]).toBeCloseTo(vec[i], 6);
  });

  it("wrong master key fails to decrypt", () => {
    const mk1 = crypto.randomBytes(32);
    const mk2 = crypto.randomBytes(32);
    const ct = encryptEmbeddingForSync(mk1, new Float32Array([1, 2, 3]));
    expect(() => decryptEmbeddingFromSync(mk2, ct)).toThrow();
  });
});

describe("syncStreamPush (cursor + wire format)", () => {
  async function seed(): Promise<void> {
    await streamClient.capture({
      surface: "discord",
      channel_ref: { c: "c1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "first",
      content_kind: "text",
      ts_ms: 1000,
    });
    await streamClient.capture({
      surface: "discord",
      channel_ref: { c: "c1" },
      side: "outbound",
      author_ref: { id: "u-me" },
      content: "second",
      content_kind: "text",
      ts_ms: 2000,
    });
  }

  it("sends a signed POST to /v1/stream/push and advances the cursor on success", async () => {
    await seed();
    const { fetchImpl, requests } = makeFakeFetch(async () =>
      new Response(
        JSON.stringify({
          accepted: [
            { event_id: "e1", server_seq: 1, duplicate: false },
            { event_id: "e2", server_seq: 2, duplicate: false },
          ],
          cursor: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await syncStreamPush(streamClient.handle, ledger, {
      endpoint: "http://localhost:9999",
      fetchImpl,
    });
    expect(result.pushed).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.cursor).toBe(2);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("http://localhost:9999/v1/stream/push");
    const body = JSON.parse(requests[0].body!);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].surface).toBe("discord");
    expect(body.events[0].embedding).not.toBeNull();
    expect(body.events[0].embedding.dims).toBe(64);
    expect(body.events[0].embedding.vec_enc.startsWith("enc:")).toBe(true);
    expect(body.events[0].content_enc.startsWith("enc:")).toBe(true);
  });

  it("only pushes events with id > last_pushed_local_id", async () => {
    await seed();
    let callCount = 0;
    const { fetchImpl } = makeFakeFetch(async () => {
      callCount++;
      const payload = callCount === 1
        ? { accepted: [
            { event_id: "e1", server_seq: 1, duplicate: false },
            { event_id: "e2", server_seq: 2, duplicate: false },
          ], cursor: 2 }
        : { accepted: [], cursor: 2 };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const first = await syncStreamPush(streamClient.handle, ledger, {
      endpoint: "http://x",
      fetchImpl,
    });
    expect(first.cursor).toBeGreaterThan(0);

    // A second push with no new events should send zero events.
    const second = await syncStreamPush(streamClient.handle, ledger, {
      endpoint: "http://x",
      fetchImpl,
    });
    expect(second.pushed).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  it("leaves the cursor unchanged when the server returns 5xx", async () => {
    await seed();
    const { fetchImpl } = makeFakeFetch(
      async () => new Response("nope", { status: 500 })
    );
    await expect(
      syncStreamPush(streamClient.handle, ledger, {
        endpoint: "http://x",
        fetchImpl,
      })
    ).rejects.toThrow(/stream push failed.*500/);
    expect(syncStreamStatus(streamClient.handle).last_pushed_local_id).toBe(0);
  });
});

describe("syncStreamPull (insertion + re-stitch)", () => {
  it("inserts events deduplicated by event_uuid, decrypts embeddings, advances cursor", async () => {
    // Use the local stream's encryption helpers to produce realistic
    // ciphertexts for the wire (matches the format both ends agree on).
    const mk = streamClient.handle.masterKey;
    const { encryptForColumn, encryptJsonForColumn } = await import("../db/encrypted-row.js");
    const fakeEmb = new FakeEmbedder();
    const vec = await fakeEmb.embed("hello-from-other-device");

    const wireEvent = {
      event_id: "remote-evt-1",
      server_seq: 42,
      client_timestamp: "2026-05-15T17:00:00.000Z",
      surface: "discord",
      side: "inbound" as const,
      content_kind: "text",
      ts_ms: 1700000000000,
      channel_ref_enc: encryptJsonForColumn(mk, "events", { c: "remote-c" }),
      author_ref_enc: encryptJsonForColumn(mk, "events", { id: "remote-u", displayName: "Alice" }),
      content_enc: encryptForColumn(mk, "events", "hello-from-other-device"),
      entity_refs_enc: null,
      ingested_at: 1700000000010,
      schema_v: 1,
      embedding: {
        vec_enc: encryptEmbeddingForSync(mk, vec),
        dims: fakeEmb.dims,
        model_enc: null,
        created_at_ms: 1700000000010,
      },
    };

    const { fetchImpl } = makeFakeFetch(async (req) => {
      if (req.method === "GET" && req.url.includes("/v1/stream/pull")) {
        return new Response(
          JSON.stringify({ events: [wireEvent], cursor: 42 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("", { status: 404 });
    });

    const result = await syncStreamPull(streamClient.handle, ledger, {
      endpoint: "http://x",
      fetchImpl,
    });
    expect(result.pulled).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.cursor).toBe(42);

    // The event should be readable locally.
    const row = streamClient.handle.db
      .prepare("SELECT event_uuid, side, embedding_id, thread_id FROM events WHERE event_uuid = ?")
      .get("remote-evt-1") as { event_uuid: string; side: string; embedding_id: number | null; thread_id: string | null };
    expect(row.event_uuid).toBe("remote-evt-1");
    expect(row.side).toBe("inbound");
    expect(row.embedding_id).not.toBeNull();
    // The stitcher creates a thread for any captured event (even the first one).
    expect(row.thread_id).toBeTruthy();

    // A second pull with the same payload should dedupe via UNIQUE(event_uuid).
    const second = await syncStreamPull(streamClient.handle, ledger, {
      endpoint: "http://x",
      fetchImpl,
    });
    // Cursor was already 42, so the GET path runs with since=42; our
    // stub returns the same envelope regardless. Applied should be 0.
    expect(second.applied).toBe(0);
  });

  it("leaves the cursor unchanged when the server returns 5xx", async () => {
    const { fetchImpl } = makeFakeFetch(
      async () => new Response("nope", { status: 500 })
    );
    await expect(
      syncStreamPull(streamClient.handle, ledger, {
        endpoint: "http://x",
        fetchImpl,
      })
    ).rejects.toThrow(/stream pull failed.*500/);
    expect(syncStreamStatus(streamClient.handle).last_pulled_server_seq).toBe(0);
  });
});

describe("syncStreamStatus", () => {
  it("reports cursor positions and pending-to-push count", async () => {
    await streamClient.capture({
      surface: "discord",
      channel_ref: { c: "x" },
      side: "outbound",
      author_ref: { id: "u-me" },
      content: "pending-1",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const status = syncStreamStatus(streamClient.handle);
    expect(status.last_pushed_local_id).toBe(0);
    expect(status.last_pulled_server_seq).toBe(0);
    expect(status.pending_events_to_push).toBe(1);
  });
});
