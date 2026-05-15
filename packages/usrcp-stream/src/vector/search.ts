import type { StreamHandle } from "../db/index.js";
import {
  decryptFromColumn,
  decryptJsonFromColumn,
} from "../db/encrypted-row.js";
import { vectorTableName } from "./index.js";
import type { ChannelRef } from "../capture/types.js";

export interface VectorSearchOptions {
  surface?: string;
  since_ms?: number;
  until_ms?: number;
  limit?: number;
  min_score?: number;
  dims: number;
}

export interface SearchHit {
  event_uuid: string;
  surface: string;
  channel_ref: ChannelRef;
  side: string;
  ts_ms: number;
  score: number;
  snippet_decrypted: string;
}

interface RawRow {
  event_uuid: string;
  surface: string;
  channel_ref: string;
  side: string;
  ts_ms: number;
  content: string;
  distance: number;
}

// Fetch this multiple of `limit` from KNN before applying surface/time
// filters, so a tight filter doesn't return fewer rows than requested.
const KNN_OVERSCAN = 4;

export function vectorSearch(
  handle: StreamHandle,
  queryVec: Float32Array,
  options: VectorSearchOptions
): SearchHit[] {
  const limit = options.limit ?? 10;
  const minScore = options.min_score ?? 0;
  const vecTable = vectorTableName(options.dims);
  const queryBuf = Buffer.from(
    queryVec.buffer,
    queryVec.byteOffset,
    queryVec.byteLength
  );

  // vec0's MATCH/k=N path uses L2 distance. We L2-normalize at ingest
  // (see embeddings/provider.ts:normalize) so L2 ordering equals cosine
  // ordering. score = 1 - d^2/2 maps L2 between unit vectors back into
  // a cosine similarity in [-1, 1].
  //
  // sqlite-vec's KNN constraint must be the only WHERE clause on the
  // virtual table — auxiliary filters go in the outer SELECT.
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (options.surface) {
    filters.push("e.surface = ?");
    filterParams.push(options.surface);
  }
  if (options.since_ms !== undefined) {
    filters.push("e.ts_ms >= ?");
    filterParams.push(options.since_ms);
  }
  if (options.until_ms !== undefined) {
    filters.push("e.ts_ms <= ?");
    filterParams.push(options.until_ms);
  }
  const filterClause =
    filters.length > 0 ? " AND " + filters.join(" AND ") : "";

  const sql = `
    SELECT
      e.event_uuid, e.surface, e.channel_ref, e.side, e.ts_ms, e.content,
      v.distance as distance
    FROM (
      SELECT rowid, distance FROM ${vecTable}
      WHERE embedding MATCH ? AND k = ?
    ) v
    JOIN events e ON e.embedding_id = v.rowid
    WHERE 1 = 1 ${filterClause}
    ORDER BY v.distance ASC
  `;

  const rows = handle.db
    .prepare(sql)
    .all(queryBuf, limit * KNN_OVERSCAN, ...filterParams) as RawRow[];

  return rows
    .map((row) => {
      const score = 1 - (row.distance * row.distance) / 2;
      return {
        event_uuid: row.event_uuid,
        surface: row.surface,
        channel_ref: decryptJsonFromColumn<ChannelRef>(
          handle.masterKey,
          "events",
          row.channel_ref
        ),
        side: row.side,
        ts_ms: row.ts_ms,
        score,
        snippet_decrypted: decryptFromColumn(
          handle.masterKey,
          "events",
          row.content
        ),
      };
    })
    .filter((hit) => hit.score >= minScore)
    .slice(0, limit);
}
