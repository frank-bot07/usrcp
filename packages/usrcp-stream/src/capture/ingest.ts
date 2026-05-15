import * as crypto from "node:crypto";
import type { StreamHandle } from "../db/index.js";
import {
  encryptForColumn,
  encryptJsonForColumn,
} from "../db/encrypted-row.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { normalize } from "../embeddings/provider.js";
import {
  ensureVectorTable,
  insertVector,
  vectorTableName,
} from "../vector/index.js";
import {
  CaptureEventSchema,
  type CaptureEvent,
  type CapturedEvent,
} from "./types.js";

export interface IngestContext {
  handle: StreamHandle;
  embedder: EmbeddingProvider | null;
  // Stitcher is wired in Phase 4; for now ingest always writes thread_id=null
  // so capture can be exercised independently. The stitcher will read the
  // freshly inserted row by event_uuid and update the thread_id column.
  stitch?: (input: {
    event_uuid: string;
    surface: string;
    ts_ms: number;
    entity_refs: string[] | undefined;
    embedding: Float32Array | null;
  }) => string | null;
}

export async function captureEvent(
  ctx: IngestContext,
  event: unknown
): Promise<CapturedEvent> {
  const parsed: CaptureEvent = CaptureEventSchema.parse(event);
  const event_uuid = crypto.randomUUID();
  const ingested_at = Date.now();
  const { handle } = ctx;

  let embedding_id: number | null = null;
  let embedding: Float32Array | null = null;
  if (ctx.embedder) {
    const raw = await ctx.embedder.embed(parsed.content);
    embedding = normalize(raw);

    ensureVectorTable(handle.db, ctx.embedder.dims);

    const inserted = handle.db
      .prepare(
        "INSERT INTO embeddings (vec, dims, model, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(
        Buffer.from(
          embedding.buffer,
          embedding.byteOffset,
          embedding.byteLength
        ),
        ctx.embedder.dims,
        ctx.embedder.model,
        ingested_at
      );
    embedding_id = Number(inserted.lastInsertRowid);

    insertVector(
      handle.db,
      vectorTableName(ctx.embedder.dims),
      embedding_id,
      embedding
    );
  }

  handle.db
    .prepare(
      `INSERT INTO events
       (event_uuid, surface, channel_ref, side, author_ref, content, content_kind,
        ts_ms, entity_refs, embedding_id, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event_uuid,
      parsed.surface,
      encryptJsonForColumn(handle.masterKey, "events", parsed.channel_ref),
      parsed.side,
      encryptJsonForColumn(handle.masterKey, "events", parsed.author_ref),
      encryptForColumn(handle.masterKey, "events", parsed.content),
      parsed.content_kind,
      parsed.ts_ms,
      parsed.entity_refs
        ? encryptJsonForColumn(handle.masterKey, "events", parsed.entity_refs)
        : null,
      embedding_id,
      ingested_at
    );

  // Presence: latest-write-wins per surface. The encrypted channel_ref
  // ensures even surface_state stays opaque on disk.
  handle.db
    .prepare(
      `INSERT INTO surface_state (surface, channel_ref, last_seen_ms, heartbeat_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(surface) DO UPDATE SET
         channel_ref = excluded.channel_ref,
         last_seen_ms = excluded.last_seen_ms,
         heartbeat_ms = excluded.heartbeat_ms`
    )
    .run(
      parsed.surface,
      encryptJsonForColumn(
        handle.masterKey,
        "surface_state",
        parsed.channel_ref
      ),
      parsed.ts_ms,
      ingested_at
    );

  let thread_id: string | null = null;
  if (ctx.stitch) {
    thread_id = ctx.stitch({
      event_uuid,
      surface: parsed.surface,
      ts_ms: parsed.ts_ms,
      entity_refs: parsed.entity_refs,
      embedding,
    });
    if (thread_id) {
      handle.db
        .prepare("UPDATE events SET thread_id = ? WHERE event_uuid = ?")
        .run(thread_id, event_uuid);
    }
  }

  return { event_uuid, thread_id, ingested_at };
}
