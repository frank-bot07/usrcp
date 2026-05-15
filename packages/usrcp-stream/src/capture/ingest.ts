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
import type { EntityResolver } from "../stitch/entity.js";
import {
  CaptureEventSchema,
  type CaptureEvent,
  type CapturedEvent,
  type ChannelRef,
} from "./types.js";

export interface IngestContext {
  handle: StreamHandle;
  embedder: EmbeddingProvider | null;
  // Best-effort entity resolver. When the caller does not supply
  // entity_refs on the event, ingest calls resolver.resolve(content) and
  // attaches whatever matches. Failure is non-fatal; capture proceeds
  // with empty entity_refs. (Codex P1-4)
  entityResolver?: EntityResolver | null;
  // Stitcher hook: when present, ingest passes the captured event's
  // metadata to the stitcher and persists the returned thread_id.
  stitch?: (input: {
    event_uuid: string;
    surface: string;
    channel_ref: ChannelRef;
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

  // Best-effort entity resolution (Codex P1-4). Only fires when the
  // caller did not supply entity_refs. Empty result keeps entity_refs
  // undefined (no encrypted column written).
  let effectiveEntityRefs = parsed.entity_refs;
  if (
    (!effectiveEntityRefs || effectiveEntityRefs.length === 0) &&
    ctx.entityResolver
  ) {
    try {
      const resolved = await ctx.entityResolver.resolve(parsed.content);
      if (resolved.length > 0) {
        effectiveEntityRefs = resolved;
      }
    } catch {
      // Best-effort. Continue with no entity refs.
    }
  }

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
      effectiveEntityRefs
        ? encryptJsonForColumn(handle.masterKey, "events", effectiveEntityRefs)
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
      channel_ref: parsed.channel_ref,
      ts_ms: parsed.ts_ms,
      entity_refs: effectiveEntityRefs,
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
