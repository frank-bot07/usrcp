/**
 * Fastify routes for `usrcp-stream` cloud sync.
 *
 * CRITICAL: the server never sees plaintext. Stream event bodies arrive
 * with their sensitive columns (channel_ref, author_ref, content,
 * entity_refs) already encrypted client-side under the
 * `stream-events` HKDF domain. Embedding vectors arrive encrypted under
 * `stream-embeddings`. The server stores all of those verbatim.
 *
 * Plaintext columns (surface, side, content_kind, ts_ms) match the
 * server's existing posture for ledger sync (domain_pseudonym +
 * timestamps stay plaintext for cursor/index purposes).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { tryAuth, numberQuery } from "./server.js";

const EmbeddingPayload = z.object({
  vec_enc: z.string().min(1).max(131072),
  dims: z.number().int().min(1).max(8192),
  model_enc: z.string().max(8192).nullable().optional(),
});

const StreamEventSchema = z.object({
  event_id: z.string().min(1).max(64),
  client_timestamp: z.string().min(1).max(40).nullable().optional(),
  surface: z.string().min(1).max(64),
  side: z.enum(["inbound", "outbound", "system"]),
  content_kind: z.string().min(1).max(32),
  ts_ms: z.number().int().min(0),
  channel_ref_enc: z.string().min(1).max(8192),
  author_ref_enc: z.string().min(1).max(8192),
  content_enc: z.string().min(1).max(131072),
  entity_refs_enc: z.string().max(8192).nullable().optional(),
  ingested_at: z.number().int().min(0),
  schema_v: z.number().int().min(1).default(1).optional(),
  idempotency_key: z.string().min(1).max(100).nullable().optional(),
  embedding: EmbeddingPayload.nullable().optional(),
});

const StreamPushBody = z.object({
  events: z.array(StreamEventSchema).min(1).max(500),
});

interface StreamEventRow {
  event_id: string;
  server_seq: string; // bigint comes back as string from node-postgres
  client_timestamp: string | null;
  server_timestamp: string;
  surface: string;
  side: string;
  content_kind: string;
  ts_ms: string;
  channel_ref_enc: string;
  author_ref_enc: string;
  content_enc: string;
  entity_refs_enc: string | null;
  ingested_at: string;
  schema_v: number;
  embedding_present: boolean;
}

interface StreamEmbeddingRow {
  event_id: string;
  vec_enc: string;
  dims: number;
  model_enc: string | null;
  created_at_ms: string;
}

export function registerStreamRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/stream/push
  app.post("/v1/stream/push", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;

    const parse = StreamPushBody.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "BAD_BODY", issues: parse.error.issues });
    }
    return pushStreamWithRetry(db, auth.userPublicKey, parse.data.events);
  });

  // GET /v1/stream/pull?since=<server_seq>&limit=<N>
  app.get("/v1/stream/pull", async (req, reply) => {
    const auth = await tryAuth(req, reply, db, "");
    if (!auth) return;
    const since = numberQuery(req.query as Record<string, unknown>, "since") ?? 0;
    const limit = Math.min(
      numberQuery(req.query as Record<string, unknown>, "limit") ?? 200,
      500
    );

    const eventsResult = await db.query<StreamEventRow>(
      `SELECT event_id, server_seq, client_timestamp, server_timestamp,
              surface, side, content_kind, ts_ms,
              channel_ref_enc, author_ref_enc, content_enc, entity_refs_enc,
              ingested_at, schema_v, embedding_present
       FROM stream_events
       WHERE user_public_key = $1 AND server_seq > $2
       ORDER BY server_seq ASC
       LIMIT $3`,
      [auth.userPublicKey, since, limit]
    );

    const eventIds = eventsResult.rows
      .filter((r) => r.embedding_present)
      .map((r) => r.event_id);

    const embeddings = new Map<string, StreamEmbeddingRow>();
    if (eventIds.length > 0) {
      const embResult = await db.query<StreamEmbeddingRow>(
        `SELECT event_id, vec_enc, dims, model_enc, created_at_ms
         FROM stream_embeddings
         WHERE user_public_key = $1 AND event_id = ANY($2::text[])`,
        [auth.userPublicKey, eventIds]
      );
      for (const row of embResult.rows) embeddings.set(row.event_id, row);
    }

    const events = eventsResult.rows.map((r) => {
      const emb = embeddings.get(r.event_id);
      return {
        event_id: r.event_id,
        server_seq: Number(r.server_seq),
        client_timestamp: r.client_timestamp,
        server_timestamp: r.server_timestamp,
        surface: r.surface,
        side: r.side,
        content_kind: r.content_kind,
        ts_ms: Number(r.ts_ms),
        channel_ref_enc: r.channel_ref_enc,
        author_ref_enc: r.author_ref_enc,
        content_enc: r.content_enc,
        entity_refs_enc: r.entity_refs_enc,
        ingested_at: Number(r.ingested_at),
        schema_v: r.schema_v,
        embedding: emb
          ? {
              vec_enc: emb.vec_enc,
              dims: emb.dims,
              model_enc: emb.model_enc,
              created_at_ms: Number(emb.created_at_ms),
            }
          : null,
      };
    });

    const cursor =
      events.length > 0 ? events[events.length - 1].server_seq : since;
    return { events, cursor };
  });
}

interface PushedStreamEvent {
  event_id: string;
  client_timestamp?: string | null;
  surface: string;
  side: string;
  content_kind: string;
  ts_ms: number;
  channel_ref_enc: string;
  author_ref_enc: string;
  content_enc: string;
  entity_refs_enc?: string | null;
  ingested_at: number;
  schema_v?: number;
  idempotency_key?: string | null;
  embedding?: { vec_enc: string; dims: number; model_enc?: string | null } | null;
}

interface PushStreamResult {
  accepted: { event_id: string; server_seq: number; duplicate: boolean }[];
  cursor: number;
}

async function pushStreamAtomic(
  db: Db,
  userPublicKey: string,
  events: PushedStreamEvent[]
): Promise<PushStreamResult> {
  return db.transaction(async (client) => {
    // Idempotency lookup: any event whose idempotency_key already exists
    // for this user is treated as a no-op (return the existing server_seq).
    const idempKeys = events
      .map((e) => e.idempotency_key)
      .filter((k): k is string => !!k);
    const existingByKey = new Map<string, { event_id: string; server_seq: number }>();
    if (idempKeys.length > 0) {
      const existing = await client.query<{
        event_id: string;
        server_seq: string;
        idempotency_key: string;
      }>(
        `SELECT event_id, server_seq, idempotency_key
         FROM stream_events
         WHERE user_public_key = $1 AND idempotency_key = ANY($2::text[])`,
        [userPublicKey, idempKeys]
      );
      for (const row of existing.rows) {
        existingByKey.set(row.idempotency_key, {
          event_id: row.event_id,
          server_seq: Number(row.server_seq),
        });
      }
    }

    // Also pre-check event_id collisions so we don't rely on
    // ON CONFLICT DO NOTHING + RETURNING semantics (real Postgres returns
    // zero rows on the conflict path; pg-mem in tests returns the
    // attempted row). Pre-filtering is also faster than letting Postgres
    // skip rows server-side and us discovering it via RETURNING.
    const eventIds = events.map((e) => e.event_id);
    const existingIdsRes = await client.query<{ event_id: string }>(
      `SELECT event_id FROM stream_events
       WHERE user_public_key = $1 AND event_id = ANY($2::text[])`,
      [userPublicKey, eventIds]
    );
    const existingIds = new Set(existingIdsRes.rows.map((r) => r.event_id));

    const accepted: PushStreamResult["accepted"] = [];
    const toInsert: PushedStreamEvent[] = [];
    const embeddingsToInsert: {
      event_id: string;
      vec_enc: string;
      dims: number;
      model_enc: string | null;
      created_at_ms: number;
    }[] = [];

    for (const ev of events) {
      if (ev.idempotency_key) {
        const dup = existingByKey.get(ev.idempotency_key);
        if (dup) {
          accepted.push({ ...dup, duplicate: true });
          continue;
        }
      }
      if (existingIds.has(ev.event_id)) {
        // Duplicate event_id without an idempotency_key; silent no-op.
        continue;
      }
      toInsert.push(ev);
      if (ev.embedding) {
        embeddingsToInsert.push({
          event_id: ev.event_id,
          vec_enc: ev.embedding.vec_enc,
          dims: ev.embedding.dims,
          model_enc: ev.embedding.model_enc ?? null,
          created_at_ms: ev.ingested_at,
        });
      }
    }

    let lastSeq = 0;
    if (toInsert.length > 0) {
      // 15 columns per row: user_public_key + 14 event fields.
      // server_seq is BIGSERIAL (assigned by Postgres on insert).
      const COLS = 15;
      const placeholders = toInsert
        .map((_, i) => {
          const base = i * COLS;
          const slots = Array.from({ length: COLS }, (_, j) => `$${base + j + 1}`);
          return `(${slots.join(", ")})`;
        })
        .join(", ");
      const params: unknown[] = [];
      for (const ev of toInsert) {
        params.push(
          userPublicKey,
          ev.event_id,
          ev.client_timestamp ?? null,
          ev.surface,
          ev.side,
          ev.content_kind,
          ev.ts_ms,
          ev.channel_ref_enc,
          ev.author_ref_enc,
          ev.content_enc,
          ev.entity_refs_enc ?? null,
          ev.ingested_at,
          ev.schema_v ?? 1,
          ev.embedding ? true : false,
          ev.idempotency_key ?? null
        );
      }
      const insertResult = await client.query<{ event_id: string; server_seq: string }>(
        `INSERT INTO stream_events
           (user_public_key, event_id, client_timestamp, surface, side,
            content_kind, ts_ms, channel_ref_enc, author_ref_enc, content_enc,
            entity_refs_enc, ingested_at, schema_v, embedding_present,
            idempotency_key)
         VALUES ${placeholders}
         ON CONFLICT (user_public_key, event_id) DO NOTHING
         RETURNING event_id, server_seq`,
        params
      );

      for (const row of insertResult.rows) {
        const seq = Number(row.server_seq);
        accepted.push({ event_id: row.event_id, server_seq: seq, duplicate: false });
        if (seq > lastSeq) lastSeq = seq;
      }
    }

    if (embeddingsToInsert.length > 0) {
      const cols = 6;
      const placeholders = embeddingsToInsert
        .map((_, i) => {
          const base = i * cols;
          return (
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
            `$${base + 5}, $${base + 6})`
          );
        })
        .join(", ");
      const params: unknown[] = [];
      for (const em of embeddingsToInsert) {
        params.push(
          userPublicKey,
          em.event_id,
          em.vec_enc,
          em.dims,
          em.model_enc,
          em.created_at_ms
        );
      }
      await client.query(
        `INSERT INTO stream_embeddings
           (user_public_key, event_id, vec_enc, dims, model_enc, created_at_ms)
         VALUES ${placeholders}
         ON CONFLICT (user_public_key, event_id) DO NOTHING`,
        params
      );
    }

    return { accepted, cursor: lastSeq };
  });
}

async function pushStreamWithRetry(
  db: Db,
  userPublicKey: string,
  events: PushedStreamEvent[],
  retries = 3,
  backoffMs = 50
): Promise<PushStreamResult> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await pushStreamAtomic(db, userPublicKey, events);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const isRetryable =
        msg.includes("40P01") ||
        msg.includes("40001") ||
        msg.includes("23505") ||
        msg.includes("deadlock") ||
        msg.includes("unique constraint") ||
        msg.includes("duplicate key");
      if (isRetryable && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}
