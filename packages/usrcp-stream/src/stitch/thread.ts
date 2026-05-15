import * as crypto from "node:crypto";
import type { StreamHandle } from "../db/index.js";
import {
  encryptJsonForColumn,
  decryptJsonFromColumn,
} from "../db/encrypted-row.js";
import { DEFAULT_STITCH, type StitchConfig } from "../config.js";

export interface StitchInput {
  event_uuid: string;
  surface: string;
  ts_ms: number;
  entity_refs: string[] | undefined;
  embedding: Float32Array | null;
}

export interface Stitcher {
  stitch(input: StitchInput): string | null;
}

interface ThreadRow {
  thread_id: string;
  first_ts_ms: number;
  last_ts_ms: number;
  surfaces: string;
  entity_refs: string | null;
  topic_centroid: Buffer | null;
  topic_dims: number | null;
  member_count: number;
}

export function makeStitcher(
  handle: StreamHandle,
  config: StitchConfig = DEFAULT_STITCH
): Stitcher {
  function candidates(input: StitchInput): ThreadRow[] {
    const widest = Math.max(
      config.entity_window_ms,
      config.topic_window_ms,
      config.same_channel_window_ms
    );
    const earliest = input.ts_ms - widest;
    return handle.db
      .prepare(
        `SELECT thread_id, first_ts_ms, last_ts_ms, surfaces, entity_refs,
                topic_centroid, topic_dims, member_count
         FROM threads
         WHERE last_ts_ms >= ?`
      )
      .all(earliest) as ThreadRow[];
  }

  function score(input: StitchInput, row: ThreadRow): number {
    const dt = Math.abs(input.ts_ms - row.last_ts_ms);

    // Entity overlap: only counted when both sides have entity refs AND
    // the gap is within the entity window. Anywhere else, the term is 0.
    let entityComponent = 0;
    if (
      input.entity_refs &&
      input.entity_refs.length > 0 &&
      row.entity_refs &&
      dt <= config.entity_window_ms
    ) {
      const threadEntities = decryptJsonFromColumn<string[]>(
        handle.masterKey,
        "threads",
        row.entity_refs
      );
      if (input.entity_refs.some((e) => threadEntities.includes(e))) {
        entityComponent = 1;
      }
    }

    // Topic similarity: cosine between this event's embedding and the
    // thread's running centroid, gated by topic_window_ms and the
    // configured cosine threshold. Below threshold = 0.
    let topicComponent = 0;
    if (
      input.embedding &&
      row.topic_centroid &&
      row.topic_dims === input.embedding.length &&
      dt <= config.topic_window_ms
    ) {
      const centroid = bufferToFloat32(row.topic_centroid);
      const cos = cosine(input.embedding, centroid);
      if (cos >= config.topic_threshold) {
        topicComponent = cos;
      }
    }

    // Recency decays exponentially with tau. Always present.
    const recencyComponent = Math.exp(-dt / config.recency_tau_ms);

    return (
      config.w_entity * entityComponent +
      config.w_topic * topicComponent +
      config.w_recency * recencyComponent
    );
  }

  function attach(input: StitchInput, row: ThreadRow): void {
    let newCentroid: Buffer | null = row.topic_centroid;
    let newDims: number | null = row.topic_dims;
    if (input.embedding) {
      const old = row.topic_centroid
        ? bufferToFloat32(row.topic_centroid)
        : null;
      const merged = mergeCentroid(old, row.member_count, input.embedding);
      newCentroid = bufferOfFloat32(merged);
      newDims = merged.length;
    }

    const surfaces = decryptJsonFromColumn<string[]>(
      handle.masterKey,
      "threads",
      row.surfaces
    );
    if (!surfaces.includes(input.surface)) surfaces.push(input.surface);

    let entityRefs: string[] = [];
    if (row.entity_refs) {
      entityRefs = decryptJsonFromColumn<string[]>(
        handle.masterKey,
        "threads",
        row.entity_refs
      );
    }
    if (input.entity_refs) {
      for (const e of input.entity_refs) {
        if (!entityRefs.includes(e)) entityRefs.push(e);
      }
    }

    handle.db
      .prepare(
        `UPDATE threads SET
           last_ts_ms     = ?,
           surfaces       = ?,
           entity_refs    = ?,
           topic_centroid = ?,
           topic_dims     = ?,
           member_count   = member_count + 1
         WHERE thread_id = ?`
      )
      .run(
        Math.max(row.last_ts_ms, input.ts_ms),
        encryptJsonForColumn(handle.masterKey, "threads", surfaces),
        entityRefs.length > 0
          ? encryptJsonForColumn(handle.masterKey, "threads", entityRefs)
          : null,
        newCentroid,
        newDims,
        row.thread_id
      );
  }

  function create(input: StitchInput): string {
    const threadId = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const surfaces = [input.surface];
    const entityRefs = input.entity_refs ?? [];

    handle.db
      .prepare(
        `INSERT INTO threads
         (thread_id, first_ts_ms, last_ts_ms, surfaces, entity_refs,
          topic_centroid, topic_dims, member_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        threadId,
        input.ts_ms,
        input.ts_ms,
        encryptJsonForColumn(handle.masterKey, "threads", surfaces),
        entityRefs.length > 0
          ? encryptJsonForColumn(handle.masterKey, "threads", entityRefs)
          : null,
        input.embedding ? bufferOfFloat32(input.embedding) : null,
        input.embedding ? input.embedding.length : null
      );
    return threadId;
  }

  return {
    stitch(input: StitchInput): string {
      const candidateRows = candidates(input);
      let best: { row: ThreadRow; s: number } | null = null;
      for (const row of candidateRows) {
        const s = score(input, row);
        if (best === null || s > best.s) {
          best = { row, s };
        }
      }
      if (best && best.s >= config.link_threshold) {
        attach(input, best.row);
        return best.row.thread_id;
      }
      return create(input);
    },
  };
}

function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
}

function bufferOfFloat32(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function mergeCentroid(
  old: Float32Array | null,
  oldN: number,
  next: Float32Array
): Float32Array {
  if (!old || oldN === 0) return next.slice();
  const out = new Float32Array(old.length);
  for (let i = 0; i < old.length; i++) {
    out[i] = (old[i] * oldN + next[i]) / (oldN + 1);
  }
  return out;
}
