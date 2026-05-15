import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import {
  decryptFromColumn,
  decryptJsonFromColumn,
} from "../db/encrypted-row.js";
import {
  MAX_STRING_SHORT,
  type AuthorRef,
  type ChannelRef,
} from "../capture/types.js";
import { okResponse, type StreamToolDef } from "./types.js";

interface EventRow {
  event_uuid: string;
  surface: string;
  channel_ref: string;
  side: string;
  author_ref: string;
  content: string;
  content_kind: string;
  ts_ms: number;
}

interface ThreadRow {
  first_ts_ms: number;
  last_ts_ms: number;
  surfaces: string;
  entity_refs: string | null;
}

export function streamThread(handle: StreamHandle): StreamToolDef {
  return {
    name: "stream_thread",
    description:
      "Fetch all events in a logical thread. A thread spans surfaces — events from " +
      "Discord, iMessage, and Cursor that share entity references or topic similarity " +
      "within their respective windows are stitched into one thread_id at capture time.",
    kind: "multi-domain-read",
    scopeOf: () => "all",
    inputShape: {
      thread_id: z.string().min(1).max(MAX_STRING_SHORT),
      limit: z.number().int().positive().max(500).optional(),
      before_ms: z.number().int().nonnegative().optional(),
    },
    handler: async (params) => {
      const limit = params.limit ?? 100;
      const beforeClause = params.before_ms ? "AND ts_ms < ?" : "";
      const sql = `
        SELECT event_uuid, surface, channel_ref, side, author_ref, content,
               content_kind, ts_ms
        FROM events
        WHERE thread_id = ? ${beforeClause}
        ORDER BY ts_ms ASC
        LIMIT ?
      `;
      const sqlParams: unknown[] = [params.thread_id];
      if (params.before_ms) sqlParams.push(params.before_ms);
      sqlParams.push(limit);

      const eventRows = handle.db.prepare(sql).all(...sqlParams) as EventRow[];
      const threadRow = handle.db
        .prepare(
          "SELECT first_ts_ms, last_ts_ms, surfaces, entity_refs FROM threads WHERE thread_id = ?"
        )
        .get(params.thread_id) as ThreadRow | undefined;

      if (!threadRow) {
        return okResponse({
          status: "not_found",
          thread_id: params.thread_id,
          events: [],
        });
      }

      const surfaces = decryptJsonFromColumn<string[]>(
        handle.masterKey,
        "threads",
        threadRow.surfaces
      );
      const entityRefs = threadRow.entity_refs
        ? decryptJsonFromColumn<string[]>(
            handle.masterKey,
            "threads",
            threadRow.entity_refs
          )
        : [];

      const events = eventRows.map((row) => ({
        event_uuid: row.event_uuid,
        surface: row.surface,
        channel_ref: decryptJsonFromColumn<ChannelRef>(
          handle.masterKey,
          "events",
          row.channel_ref
        ),
        side: row.side,
        author_ref: decryptJsonFromColumn<AuthorRef>(
          handle.masterKey,
          "events",
          row.author_ref
        ),
        content: decryptFromColumn(handle.masterKey, "events", row.content),
        content_kind: row.content_kind,
        ts_ms: row.ts_ms,
      }));

      return okResponse({
        status: "ok",
        thread_id: params.thread_id,
        first_ts_ms: threadRow.first_ts_ms,
        last_ts_ms: threadRow.last_ts_ms,
        surfaces,
        entity_refs: entityRefs,
        events,
      });
    },
  };
}
