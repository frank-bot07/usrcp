import * as crypto from "node:crypto";
import type { StreamHandle } from "../db/index.js";
import {
  encryptJsonForColumn,
  decryptJsonFromColumn,
  encryptForColumn,
  decryptFromColumn,
} from "../db/encrypted-row.js";
import { DEFAULT_STITCH, type StitchConfig } from "../config.js";
import type { ChannelRef } from "../capture/types.js";

export interface StitchInput {
  event_uuid: string;
  surface: string;
  // Codex P1-1: channel_ref is now part of stitch input so same-channel
  // continuation can be a candidate AND a score signal.
  channel_ref: ChannelRef;
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
  // Codex P1-2: topic_centroid is now encrypted TEXT, not raw float32
  // BLOB. The stitcher decrypts on read and re-encrypts on update; the
  // encrypted form is a base64-packed Float32Array inside an enc:-prefixed
  // string under HKDF domain stream-threads.
  topic_centroid: string | null;
  topic_dims: number | null;
  member_count: number;
  // Codex P1-1: encrypted JSON array of canonical-form channel keys for
  // same-channel continuation candidacy.
  recent_channels: string | null;
}

// Stable canonical form for ChannelRef equality. We sort keys so that
// {guild,channel} and {channel,guild} compare equal. Values must be
// JSON-stringifiable (the zod schema already enforces this).
function channelKey(ref: ChannelRef): string {
  const sortedKeys = Object.keys(ref).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of sortedKeys) ordered[k] = ref[k];
  return JSON.stringify(ordered);
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
                topic_centroid, topic_dims, member_count, recent_channels
         FROM threads
         WHERE last_ts_ms >= ?`
      )
      .all(earliest) as ThreadRow[];
  }

  function sameChannelMatch(input: StitchInput, row: ThreadRow): boolean {
    const dt = Math.abs(input.ts_ms - row.last_ts_ms);
    if (dt > config.same_channel_window_ms) return false;
    if (!row.recent_channels) return false;
    try {
      const channels = decryptJsonFromColumn<string[]>(
        handle.masterKey,
        "threads",
        row.recent_channels
      );
      return channels.includes(channelKey(input.channel_ref));
    } catch {
      return false;
    }
  }

  function entityOverlapMatch(input: StitchInput, row: ThreadRow): boolean {
    if (!input.entity_refs || input.entity_refs.length === 0) return false;
    if (!row.entity_refs) return false;
    const dt = Math.abs(input.ts_ms - row.last_ts_ms);
    if (dt > config.entity_window_ms) return false;
    const threadEntities = decryptJsonFromColumn<string[]>(
      handle.masterKey,
      "threads",
      row.entity_refs
    );
    return input.entity_refs.some((e) => threadEntities.includes(e));
  }

  function score(input: StitchInput, row: ThreadRow): number {
    const dt = Math.abs(input.ts_ms - row.last_ts_ms);

    // Entity component: 1 if entity_refs overlap within entity_window OR
    // if the event is on a channel this thread has been on within
    // same_channel_window_ms. The same-channel signal piggybacks on the
    // entity weight because the build prompt's scoring formula has no
    // dedicated same-channel term; a channel match is a strong
    // "same-conversation" signal in practice (Codex P1-1).
    let entityComponent = 0;
    if (entityOverlapMatch(input, row)) {
      entityComponent = 1;
    } else if (sameChannelMatch(input, row)) {
      entityComponent = 1;
    }

    // Topic similarity.
    let topicComponent = 0;
    if (
      input.embedding &&
      row.topic_centroid &&
      row.topic_dims === input.embedding.length &&
      dt <= config.topic_window_ms
    ) {
      try {
        const centroid = decryptCentroid(handle.masterKey, row.topic_centroid);
        const cos = cosine(input.embedding, centroid);
        if (cos >= config.topic_threshold) {
          topicComponent = cos;
        }
      } catch {
        // Corrupt or wrong-key centroid: skip the topic signal.
      }
    }

    const recencyComponent = Math.exp(-dt / config.recency_tau_ms);

    return (
      config.w_entity * entityComponent +
      config.w_topic * topicComponent +
      config.w_recency * recencyComponent
    );
  }

  function attach(input: StitchInput, row: ThreadRow): void {
    let newCentroid: string | null = row.topic_centroid;
    let newDims: number | null = row.topic_dims;
    if (input.embedding) {
      const old = row.topic_centroid
        ? decryptCentroidOrNull(handle.masterKey, row.topic_centroid)
        : null;
      const merged = mergeCentroid(old, row.member_count, input.embedding);
      newCentroid = encryptCentroid(handle.masterKey, merged);
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

    let channels: string[] = [];
    if (row.recent_channels) {
      try {
        channels = decryptJsonFromColumn<string[]>(
          handle.masterKey,
          "threads",
          row.recent_channels
        );
      } catch {
        channels = [];
      }
    }
    const newKey = channelKey(input.channel_ref);
    if (!channels.includes(newKey)) channels.push(newKey);
    // Bound size to keep recent_channels stable; oldest evicted first.
    while (channels.length > 32) channels.shift();

    handle.db
      .prepare(
        `UPDATE threads SET
           last_ts_ms      = ?,
           surfaces        = ?,
           entity_refs     = ?,
           topic_centroid  = ?,
           topic_dims      = ?,
           member_count    = member_count + 1,
           recent_channels = ?
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
        encryptJsonForColumn(handle.masterKey, "threads", channels),
        row.thread_id
      );
  }

  function create(input: StitchInput): string {
    const threadId = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const surfaces = [input.surface];
    const entityRefs = input.entity_refs ?? [];
    const channels = [channelKey(input.channel_ref)];

    handle.db
      .prepare(
        `INSERT INTO threads
         (thread_id, first_ts_ms, last_ts_ms, surfaces, entity_refs,
          topic_centroid, topic_dims, member_count, recent_channels)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        threadId,
        input.ts_ms,
        input.ts_ms,
        encryptJsonForColumn(handle.masterKey, "threads", surfaces),
        entityRefs.length > 0
          ? encryptJsonForColumn(handle.masterKey, "threads", entityRefs)
          : null,
        input.embedding
          ? encryptCentroid(handle.masterKey, input.embedding)
          : null,
        input.embedding ? input.embedding.length : null,
        encryptJsonForColumn(handle.masterKey, "threads", channels)
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

// Encrypted centroid format: a base64-packed Float32Array buffer
// encrypted via encryptForColumn with HKDF domain stream-threads. The
// result is a TEXT enc:-prefixed string indistinguishable on disk from
// any other encrypted thread column.
function encryptCentroid(masterKey: Buffer, vec: Float32Array): string {
  const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return encryptForColumn(masterKey, "threads", bytes.toString("base64"));
}

function decryptCentroid(masterKey: Buffer, ciphertext: string): Float32Array {
  const b64 = decryptFromColumn(masterKey, "threads", ciphertext);
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
}

function decryptCentroidOrNull(
  masterKey: Buffer,
  ciphertext: string
): Float32Array | null {
  try {
    return decryptCentroid(masterKey, ciphertext);
  } catch {
    return null;
  }
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
