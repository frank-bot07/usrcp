import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { Db, type PoolLike } from "usrcp-cloud/dist/db.js";
import { createApp } from "usrcp-cloud/dist/server.js";
import { Ledger } from "usrcp-core/ledger";
import { setUserSlug, initializeMasterKey } from "usrcp-core/encryption";
import { createStreamCaptureClient } from "../capture-client.js";
import { syncStreamPush, syncStreamPull, syncStreamStatus } from "../sync.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// Deterministic embedder so we can assert vec roundtrip without Ollama.
class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake-deterministic";
  async embed(text: string): Promise<Float32Array> {
    const h = crypto.createHash("sha256").update(text).digest();
    const v = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) v[i] = (h[i % h.length] / 255) * 2 - 1;
    return v;
  }
}

// In-process Fastify app backed by pg-mem. We adapt its inject() to
// look like a fetch() so the stream sync client can call it with its
// existing signed-request flow.
async function makeCloudFetch(): Promise<{
  fetchImpl: typeof fetch;
  app: FastifyInstance;
  cloudDb: Db;
}> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as PoolLike;
  const cloudDb = new Db(pool);
  await cloudDb.migrate();
  const app = createApp({ db: cloudDb, logger: false });
  await app.ready();

  const fetchImpl: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const pathWithQuery = u.pathname + (u.search || "");
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: pathWithQuery,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body ? String(init.body) : undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, app, cloudDb };
}

// In the production multi-device model, the user has ONE Ed25519
// identity that lives in the ledger and is shared across machines
// (copied during pairing, or by transferring the keys/ dir manually).
// For the test, alice and bob represent two stream.db files belonging
// to the same user - the cloud server sees them under one
// user_public_key. We model that with one Ledger instance and two
// StreamHandles backed by different dbPaths.

import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { loadVectorExtension } from "../vector/index.js";

interface DeviceStream {
  handle: StreamHandle;
  embedder: EmbeddingProvider;
}

function makeDeviceStream(
  userDir: string,
  masterKey: Buffer,
  embedder: EmbeddingProvider,
  label: string
): DeviceStream {
  const dbPath = path.join(userDir, `stream-${label}.db`);
  const handle = openStreamDb(userDir, masterKey, { dbPath });
  loadVectorExtension(handle.db);
  return { handle, embedder };
}

async function deviceCapture(
  device: DeviceStream,
  ledger: Ledger,
  event: {
    surface: string;
    channel_ref: Record<string, unknown>;
    side: "inbound" | "outbound";
    author_ref: { id: string; displayName?: string };
    content: string;
    ts_ms: number;
  }
): Promise<{ event_uuid: string; thread_id: string | null }> {
  const { captureEvent } = await import("../capture/ingest.js");
  const { makeStitcher } = await import("../stitch/thread.js");
  const stitcher = makeStitcher(device.handle);
  return captureEvent(
    {
      handle: device.handle,
      embedder: device.embedder,
      stitch: (input) => stitcher.stitch(input),
    },
    { ...event, content_kind: "text" }
  );
}

let cloud: Awaited<ReturnType<typeof makeCloudFetch>>;
let homeRoot: string;
let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let alice: DeviceStream;
let bob: DeviceStream;
const PASSPHRASE = "correct-horse-battery-staple-sync-test";

beforeEach(async () => {
  origHome = process.env.HOME;
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-sync-int-"));
  tmpHome = fs.mkdtempSync(path.join(homeRoot, "user-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  cloud = await makeCloudFetch();
  // One user identity (shared across "devices" in the real multi-
  // device model).
  initializeMasterKey(PASSPHRASE);
  ledger = new Ledger(path.join(tmpHome, "ledger.db"), PASSPHRASE);
  alice = makeDeviceStream(tmpHome, ledger.getMasterKey(), new FakeEmbedder(), "alice");
  bob = makeDeviceStream(tmpHome, ledger.getMasterKey(), new FakeEmbedder(), "bob");
});

afterEach(async () => {
  try { closeStreamDb(alice.handle); } catch { /* */ }
  try { closeStreamDb(bob.handle); } catch { /* */ }
  try { ledger.close(); } catch { /* */ }
  try { await cloud.app.close(); } catch { /* */ }
  try { await cloud.cloudDb.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

describe("stream cloud sync end-to-end", () => {
  it("alice push -> bob pull: events arrive on bob with same content and re-derived thread state", async () => {
    const baseTs = 1_700_000_000_000;
    const cap1 = await deviceCapture(alice, ledger, {
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      side: "outbound",
      author_ref: { id: "u-frank", displayName: "Frank" },
      content: "alice-event-1",
      ts_ms: baseTs,
    });
    const cap2 = await deviceCapture(alice, ledger, {
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      side: "outbound",
      author_ref: { id: "u-frank", displayName: "Frank" },
      content: "alice-event-2",
      ts_ms: baseTs + 60_000,
    });
    const cap3 = await deviceCapture(alice, ledger, {
      surface: "imessage",
      channel_ref: { chatId: "+15551234" },
      side: "inbound",
      author_ref: { id: "u-alice-other", displayName: "Alice" },
      content: "alice-event-3-different-surface",
      ts_ms: baseTs + 120_000,
    });
    expect(cap1.thread_id).toBeTruthy();
    expect(cap2.thread_id).toBe(cap1.thread_id);
    expect(cap3.thread_id).toBeTruthy();
    expect(cap3.thread_id).not.toBe(cap1.thread_id);

    const pushed = await syncStreamPush(alice.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    expect(pushed.pushed).toBe(3);
    expect(pushed.duplicates).toBe(0);

    const pulled = await syncStreamPull(bob.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    expect(pulled.pulled).toBe(3);
    expect(pulled.applied).toBe(3);
    expect(pulled.threads_rebuilt).toBe(3);

    const { decryptFromColumn } = await import("../db/encrypted-row.js");
    const bobRows = bob.handle.db
      .prepare("SELECT event_uuid, content FROM events ORDER BY ts_ms ASC")
      .all() as { event_uuid: string; content: string }[];
    expect(bobRows).toHaveLength(3);
    const decrypted = bobRows.map((r) =>
      decryptFromColumn(bob.handle.masterKey, "events", r.content)
    );
    expect(decrypted).toEqual([
      "alice-event-1",
      "alice-event-2",
      "alice-event-3-different-surface",
    ]);

    const bobThreads = bob.handle.db
      .prepare("SELECT event_uuid, thread_id FROM events ORDER BY ts_ms ASC")
      .all() as { event_uuid: string; thread_id: string | null }[];
    expect(bobThreads[0].thread_id).toBeTruthy();
    expect(bobThreads[1].thread_id).toBe(bobThreads[0].thread_id);
    expect(bobThreads[2].thread_id).not.toBe(bobThreads[0].thread_id);

    const embCount = bob.handle.db
      .prepare("SELECT COUNT(*) as c FROM embeddings")
      .get() as { c: number };
    expect(embCount.c).toBe(3);
  });

  it("second pull is a no-op when cursor has caught up", async () => {
    await deviceCapture(alice, ledger, {
      surface: "discord",
      channel_ref: { c: "x" },
      side: "outbound",
      author_ref: { id: "u-me" },
      content: "one",
      ts_ms: 1000,
    });
    await syncStreamPush(alice.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    const first = await syncStreamPull(bob.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    expect(first.applied).toBe(1);

    const second = await syncStreamPull(bob.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    expect(second.pulled).toBe(0);
    expect(second.applied).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  it("no plaintext on the server: dump stream_events.content_enc and verify no needle bytes appear", async () => {
    const needle = "PLAINTEXT_NEEDLE_FOR_GREP";
    await deviceCapture(alice, ledger, {
      surface: "discord",
      channel_ref: { c: "x" },
      side: "outbound",
      author_ref: { id: "u-me" },
      content: needle,
      ts_ms: 1000,
    });
    await syncStreamPush(alice.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });

    const dump = await cloud.cloudDb.query<{
      content_enc: string;
      channel_ref_enc: string;
      author_ref_enc: string;
    }>(
      "SELECT content_enc, channel_ref_enc, author_ref_enc FROM stream_events LIMIT 1"
    );
    expect(dump.rows[0].content_enc).toMatch(/^enc:/);
    expect(dump.rows[0].content_enc).not.toContain(needle);
    expect(dump.rows[0].channel_ref_enc).not.toContain(needle);

    const embDump = await cloud.cloudDb.query<{ vec_enc: string }>(
      "SELECT vec_enc FROM stream_embeddings LIMIT 1"
    );
    expect(embDump.rows[0].vec_enc).toMatch(/^enc:/);
  });

  it("status reflects cursor positions after a push+pull cycle", async () => {
    await deviceCapture(alice, ledger, {
      surface: "discord",
      channel_ref: { c: "x" },
      side: "outbound",
      author_ref: { id: "u-me" },
      content: "one",
      ts_ms: 1000,
    });
    const beforePush = syncStreamStatus(alice.handle, {});
    expect(beforePush.pending_events_to_push).toBe(1);
    expect(beforePush.last_pushed_local_id).toBe(0);

    await syncStreamPush(alice.handle, ledger, {
      endpoint: "http://cloud.local",
      fetchImpl: cloud.fetchImpl,
    });
    const afterPush = syncStreamStatus(alice.handle, {});
    expect(afterPush.pending_events_to_push).toBe(0);
    expect(afterPush.last_pushed_local_id).toBe(1);
  });
});
