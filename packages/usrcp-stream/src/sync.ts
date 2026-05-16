/**
 * Stream cloud sync client. Mirrors usrcp-local/src/sync.ts but for the
 * stream-side DB tables and the /v1/stream/* routes added in usrcp-cloud.
 *
 * Three operations:
 *   - syncStreamPush(handle, ledger, opts):  push local events (and their
 *                                            encrypted embeddings) to the
 *                                            cloud, advance the
 *                                            last_pushed_local_id cursor
 *                                            on success.
 *   - syncStreamPull(handle, ledger, opts):  pull events the cloud has
 *                                            past our last_pulled_server_seq,
 *                                            insert locally (encrypted
 *                                            columns ride through; vectors
 *                                            decrypt + insert into the
 *                                            sqlite-vec virtual table),
 *                                            then re-stitch threads.
 *   - syncStreamStatus(handle, opts):        report cursor positions and
 *                                            pending event count.
 *
 * Threads, surface_state, and stream-config are NOT synced - they are
 * device-local by design.
 */

import * as crypto from "node:crypto";
import type { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  getIdentity,
  getDecryptedPrivateKeyPem,
} from "usrcp-local/dist/crypto.js";
import type { StreamHandle } from "./db/index.js";
import {
  encryptEmbeddingForSync,
  decryptEmbeddingFromSync,
  encryptEmbeddingModelForSync,
  decryptEmbeddingModelFromSync,
} from "./db/encrypted-row.js";
import { makeStitcher } from "./stitch/thread.js";
import {
  ensureVectorTable,
  insertVector,
} from "./vector/index.js";

// --- Public types ---

export interface SyncStreamOptions {
  endpoint?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface SyncStreamPushResult {
  pushed: number;
  duplicates: number;
  cursor: number;
}

export interface SyncStreamPullResult {
  pulled: number;
  applied: number;
  cursor: number;
  threads_rebuilt: number;
}

export interface SyncStreamStatus {
  cloud_endpoint: string | null;
  last_pushed_local_id: number;
  last_pulled_server_seq: number;
  last_sync_at: string | null;
  pending_events_to_push: number;
}

// --- Signing (duplicated from usrcp-local/src/sync.ts to keep stream
// decoupled from local's internal signing helper; if either changes, the
// other must follow). Both files must produce identical canonical bytes.
function canonicalRequest(
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canon = [
    method.toUpperCase(),
    path,
    String(timestampMs),
    nonce,
    bodyHash,
  ].join("\n");
  return Buffer.from(canon, "utf8");
}

function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
  body: string
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, path, timestampMs, nonce, body);
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, canon, key);
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}

async function signedFetch(
  endpoint: string,
  pathWithQuery: string,
  method: "GET" | "POST",
  body: unknown | undefined,
  publicKeyPem: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; json: unknown }> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signed = signRequest(privateKeyPem, method, pathWithQuery, bodyStr);
  const url = endpoint.replace(/\/$/, "") + pathWithQuery;
  const res = await fetchImpl(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
    body: method === "POST" ? bodyStr : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// --- Sync state helpers ---

function getState(handle: StreamHandle, key: string): string | null {
  const row = handle.db
    .prepare("SELECT v FROM sync_state WHERE k = ?")
    .get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

function setState(handle: StreamHandle, key: string, value: string): void {
  handle.db
    .prepare(
      "INSERT INTO sync_state(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    )
    .run(key, value);
}

function getLastPushedLocalId(handle: StreamHandle): number {
  const v = getState(handle, "last_pushed_local_id");
  return v ? Number(v) : 0;
}

function getLastPulledServerSeq(handle: StreamHandle): number {
  const v = getState(handle, "last_pulled_server_seq");
  return v ? Number(v) : 0;
}

function resolveEndpoint(opts: SyncStreamOptions): string {
  if (opts.endpoint) return opts.endpoint;
  // Fallback: read the ledger's cloud-config if available. Avoiding a hard
  // dep on usrcp-local's `config` module here keeps the bundle smaller;
  // callers (CLI / MCP tools) are expected to resolve the endpoint and
  // pass it in. Throwing here surfaces the misconfiguration up front.
  throw new Error(
    "No cloud endpoint configured. Pass `endpoint` to sync, or set cloud_endpoint in the ledger config."
  );
}

// --- Push ---

interface LocalEventRow {
  id: number;
  event_uuid: string;
  surface: string;
  channel_ref: string;
  side: string;
  author_ref: string;
  content: string;
  content_kind: string;
  ts_ms: number;
  entity_refs: string | null;
  embedding_id: number | null;
  ingested_at: number;
  schema_v: number;
}

interface LocalEmbeddingRow {
  id: number;
  vec: Buffer;
  dims: number;
  model: string;
  created_at: number;
}

// The `_ledger` parameter is reserved for the v0.2 entity-resolver path
// (rebuilding entity_refs on pull). It's accepted now to lock the
// public signature; today the function only needs handle.masterKey +
// the global identity helpers from usrcp-local.

export async function syncStreamPush(
  handle: StreamHandle,
  _ledger: Ledger,
  opts: SyncStreamOptions = {}
): Promise<SyncStreamPushResult> {
  const endpoint = resolveEndpoint(opts);
  const identity = getIdentity();
  if (!identity) throw new Error("Ledger identity missing; cannot sign sync request");
  const privateKeyPem = getDecryptedPrivateKeyPem(handle.masterKey);

  const lastPushed = getLastPushedLocalId(handle);
  const limit = opts.limit ?? 200;
  const rows = handle.db
    .prepare(
      `SELECT id, event_uuid, surface, channel_ref, side, author_ref, content,
              content_kind, ts_ms, entity_refs, embedding_id, ingested_at, schema_v
       FROM events
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(lastPushed, limit) as LocalEventRow[];

  if (rows.length === 0) {
    return { pushed: 0, duplicates: 0, cursor: lastPushed };
  }

  const wireEvents = rows.map((r) => {
    let embedding: {
      vec_enc: string;
      dims: number;
      model_enc: string | null;
    } | null = null;
    if (r.embedding_id !== null) {
      const emb = handle.db
        .prepare("SELECT id, vec, dims, model, created_at FROM embeddings WHERE id = ?")
        .get(r.embedding_id) as LocalEmbeddingRow | undefined;
      if (emb) {
        const vec = new Float32Array(
          emb.vec.buffer.slice(
            emb.vec.byteOffset,
            emb.vec.byteOffset + emb.vec.byteLength
          )
        );
        embedding = {
          vec_enc: encryptEmbeddingForSync(handle.masterKey, vec),
          dims: emb.dims,
          model_enc: encryptEmbeddingModelForSync(handle.masterKey, emb.model),
        };
      }
    }

    return {
      event_id: r.event_uuid,
      client_timestamp: new Date(r.ingested_at).toISOString(),
      surface: r.surface,
      side: r.side,
      content_kind: r.content_kind,
      ts_ms: r.ts_ms,
      channel_ref_enc: r.channel_ref,
      author_ref_enc: r.author_ref,
      content_enc: r.content,
      entity_refs_enc: r.entity_refs,
      ingested_at: r.ingested_at,
      schema_v: r.schema_v,
      idempotency_key: r.event_uuid,
      embedding,
    };
  });

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await signedFetch(
    endpoint,
    "/v1/stream/push",
    "POST",
    { events: wireEvents },
    identity.public_key,
    privateKeyPem,
    fetchImpl
  );

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `stream push failed: HTTP ${res.status}: ${JSON.stringify(res.json)}`
    );
  }

  const body = res.json as
    | { accepted: { event_id: string; server_seq: number; duplicate: boolean }[]; cursor: number }
    | null;
  const accepted = body?.accepted ?? [];
  const duplicates = accepted.filter((a) => a.duplicate).length;
  const pushed = accepted.length - duplicates;

  // Advance the cursor to the max local id we just sent. Even
  // duplicates count - the server has them already, we just want to
  // stop re-sending.
  const maxLocalId = rows[rows.length - 1].id;
  setState(handle, "last_pushed_local_id", String(maxLocalId));
  setState(handle, "last_sync_at", new Date().toISOString());

  return { pushed, duplicates, cursor: maxLocalId };
}

// --- Pull ---

interface PulledEvent {
  event_id: string;
  server_seq: number;
  client_timestamp: string | null;
  surface: string;
  side: string;
  content_kind: string;
  ts_ms: number;
  channel_ref_enc: string;
  author_ref_enc: string;
  content_enc: string;
  entity_refs_enc: string | null;
  ingested_at: number;
  schema_v: number;
  embedding: {
    vec_enc: string;
    dims: number;
    model_enc: string | null;
    created_at_ms: number;
  } | null;
}

export async function syncStreamPull(
  handle: StreamHandle,
  _ledger: Ledger,
  opts: SyncStreamOptions = {}
): Promise<SyncStreamPullResult> {
  const endpoint = resolveEndpoint(opts);
  const identity = getIdentity();
  if (!identity) throw new Error("Ledger identity missing; cannot sign sync request");
  const privateKeyPem = getDecryptedPrivateKeyPem(handle.masterKey);

  const lastPulled = getLastPulledServerSeq(handle);
  const limit = opts.limit ?? 200;
  const path = `/v1/stream/pull?since=${lastPulled}&limit=${limit}`;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await signedFetch(
    endpoint,
    path,
    "GET",
    undefined,
    identity.public_key,
    privateKeyPem,
    fetchImpl
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `stream pull failed: HTTP ${res.status}: ${JSON.stringify(res.json)}`
    );
  }
  const body = res.json as { events: PulledEvent[]; cursor: number } | null;
  const incoming = body?.events ?? [];

  if (incoming.length === 0) {
    return { pulled: 0, applied: 0, cursor: lastPulled, threads_rebuilt: 0 };
  }

  // Process in a transaction so a mid-batch failure rolls back cleanly.
  const stitcher = makeStitcher(handle);
  let applied = 0;
  let threadsRebuilt = 0;

  const insertEvent = handle.db.prepare(
    `INSERT OR IGNORE INTO events
       (event_uuid, surface, channel_ref, side, author_ref, content, content_kind,
        ts_ms, entity_refs, embedding_id, ingested_at, schema_v)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEmbedding = handle.db.prepare(
    `INSERT INTO embeddings(vec, dims, model, created_at) VALUES (?, ?, ?, ?)`
  );
  const updateThreadId = handle.db.prepare(
    `UPDATE events SET thread_id = ? WHERE event_uuid = ?`
  );
  const fetchEmbedding = handle.db.prepare(
    `SELECT vec FROM embeddings WHERE id = ?`
  );

  const tx = handle.db.transaction((events: PulledEvent[]) => {
    for (const ev of events) {
      let embeddingId: number | null = null;
      let localVec: Float32Array | null = null;
      if (ev.embedding) {
        localVec = decryptEmbeddingFromSync(handle.masterKey, ev.embedding.vec_enc);
        const model =
          ev.embedding.model_enc != null
            ? decryptEmbeddingModelFromSync(handle.masterKey, ev.embedding.model_enc)
            : "";
        const r = insertEmbedding.run(
          Buffer.from(localVec.buffer, localVec.byteOffset, localVec.byteLength),
          ev.embedding.dims,
          model,
          ev.embedding.created_at_ms
        );
        embeddingId = Number(r.lastInsertRowid);
      }
      const result = insertEvent.run(
        ev.event_id,
        ev.surface,
        ev.channel_ref_enc,
        ev.side,
        ev.author_ref_enc,
        ev.content_enc,
        ev.content_kind,
        ev.ts_ms,
        ev.entity_refs_enc,
        embeddingId,
        ev.ingested_at,
        ev.schema_v
      );
      if (result.changes > 0) applied++;
    }
  });

  tx(incoming);

  // After the transactional insert, write the vector rows into the
  // sqlite-vec virtual tables. Doing this after-the-fact (outside the
  // tx) keeps the schema and the index loosely coupled - if sqlite-vec
  // fails to load on this device, the events still arrive correctly.
  for (const ev of incoming) {
    if (!ev.embedding) continue;
    const localEmbId = handle.db
      .prepare(
        `SELECT embedding_id FROM events WHERE event_uuid = ?`
      )
      .get(ev.event_id) as { embedding_id: number | null } | undefined;
    if (!localEmbId?.embedding_id) continue;
    const vecRow = fetchEmbedding.get(localEmbId.embedding_id) as
      | { vec: Buffer }
      | undefined;
    if (!vecRow) continue;
    try {
      ensureVectorTable(handle.db, ev.embedding.dims);
      const vec = new Float32Array(
        vecRow.vec.buffer.slice(
          vecRow.vec.byteOffset,
          vecRow.vec.byteOffset + vecRow.vec.byteLength
        )
      );
      insertVector(
        handle.db,
        `event_vec_${ev.embedding.dims}`,
        localEmbId.embedding_id,
        vec
      );
    } catch (err) {
      console.error(
        `[usrcp-stream] failed to index pulled embedding for ${ev.event_id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Re-stitch the pulled events in chronological order. The stitcher
  // is deterministic relative to its candidate set, so a device that
  // pulls in a different order may get different thread IDs, but
  // content is identical and per-device thread IDs are local artifacts.
  const sorted = incoming.slice().sort((a, b) => a.ts_ms - b.ts_ms);
  for (const ev of sorted) {
    // Decrypt channel_ref to feed the stitcher; it needs the
    // canonical channel key for same-channel candidacy.
    const channelRef = JSON.parse(
      (await import("./db/encrypted-row.js")).decryptFromColumn(
        handle.masterKey,
        "events",
        ev.channel_ref_enc
      )
    ) as Record<string, unknown>;
    const entityRefs = ev.entity_refs_enc
      ? (JSON.parse(
          (await import("./db/encrypted-row.js")).decryptFromColumn(
            handle.masterKey,
            "events",
            ev.entity_refs_enc
          )
        ) as string[])
      : undefined;
    const local = handle.db
      .prepare(
        `SELECT embedding_id FROM events WHERE event_uuid = ?`
      )
      .get(ev.event_id) as { embedding_id: number | null } | undefined;
    let embedding: Float32Array | null = null;
    if (local?.embedding_id) {
      const vecRow = handle.db
        .prepare(`SELECT vec FROM embeddings WHERE id = ?`)
        .get(local.embedding_id) as { vec: Buffer } | undefined;
      if (vecRow) {
        embedding = new Float32Array(
          vecRow.vec.buffer.slice(
            vecRow.vec.byteOffset,
            vecRow.vec.byteOffset + vecRow.vec.byteLength
          )
        );
      }
    }
    const threadId = stitcher.stitch({
      event_uuid: ev.event_id,
      surface: ev.surface,
      channel_ref: channelRef,
      ts_ms: ev.ts_ms,
      entity_refs: entityRefs,
      embedding,
    });
    if (threadId) {
      updateThreadId.run(threadId, ev.event_id);
      threadsRebuilt++;
    }
  }

  const cursor = body?.cursor ?? lastPulled;
  setState(handle, "last_pulled_server_seq", String(cursor));
  setState(handle, "last_sync_at", new Date().toISOString());

  return { pulled: incoming.length, applied, cursor, threads_rebuilt: threadsRebuilt };
}

// --- Status ---

export function syncStreamStatus(
  handle: StreamHandle,
  opts: SyncStreamOptions = {}
): SyncStreamStatus {
  const lastPushed = getLastPushedLocalId(handle);
  const lastPulled = getLastPulledServerSeq(handle);
  const lastSyncAt = getState(handle, "last_sync_at");
  const pendingRow = handle.db
    .prepare("SELECT COUNT(*) as c FROM events WHERE id > ?")
    .get(lastPushed) as { c: number };
  return {
    cloud_endpoint: opts.endpoint ?? null,
    last_pushed_local_id: lastPushed,
    last_pulled_server_seq: lastPulled,
    last_sync_at: lastSyncAt,
    pending_events_to_push: pendingRow.c,
  };
}

