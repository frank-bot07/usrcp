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
  entity_refs: string | null;
}

interface ThreadRow {
  first_ts_ms: number;
  last_ts_ms: number;
  surfaces: string;
  entity_refs: string | null;
}

export interface StreamThreadOptions {
  // Surface allowlist for scope enforcement. When set, the handler does
  // not return any thread-level metadata until the allowed-surface event
  // query proves at least one in-scope event exists, and even then the
  // returned `surfaces` / `entity_refs` / `first_ts_ms` / `last_ts_ms`
  // are derived from the in-scope event subset, NOT from the thread row.
  // (Codex round-2 P0-1)
  allowedScopes?: string[];
}

export function streamThread(
  handle: StreamHandle,
  options: StreamThreadOptions = {}
): StreamToolDef {
  return {
    name: "stream_thread",
    description:
      "Fetch all events in a logical thread. A thread spans surfaces. Events from " +
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
      const scoped =
        !!options.allowedScopes && options.allowedScopes.length > 0;
      const limit = params.limit ?? 100;
      const beforeClause = params.before_ms ? "AND ts_ms < ?" : "";
      const surfaceClause = scoped
        ? `AND surface IN (${options.allowedScopes!.map(() => "?").join(",")})`
        : "";
      const sql = `
        SELECT event_uuid, surface, channel_ref, side, author_ref, content,
               content_kind, ts_ms, entity_refs
        FROM events
        WHERE thread_id = ? ${beforeClause} ${surfaceClause}
        ORDER BY ts_ms ASC
        LIMIT ?
      `;
      const sqlParams: unknown[] = [params.thread_id];
      if (params.before_ms) sqlParams.push(params.before_ms);
      if (scoped) sqlParams.push(...options.allowedScopes!);
      sqlParams.push(limit);

      const eventRows = handle.db.prepare(sql).all(...sqlParams) as EventRow[];

      // Scoped + zero in-scope events: do not load the thread row, do
      // not decrypt thread-level metadata, do not reveal that the
      // thread exists in another surface. Return not_found.
      if (scoped && eventRows.length === 0) {
        return okResponse({
          status: "not_found",
          thread_id: params.thread_id,
          events: [],
        });
      }

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
        entity_refs:
          row.entity_refs &&
          decryptJsonFromColumn<string[]>(
            handle.masterKey,
            "events",
            row.entity_refs
          ),
      }));

      let surfaces: string[];
      let entityRefs: string[];
      let firstTsMs: number;
      let lastTsMs: number;

      if (scoped) {
        // In scoped mode, derive every metadata field from the
        // in-scope events themselves. Thread-row metadata (entity_refs,
        // surfaces, first/last_ts) reflects the full union of all
        // surfaces and could otherwise leak the existence of, and
        // attributes of, out-of-scope events.
        surfaces = Array.from(new Set(events.map((e) => e.surface)));
        const inScopeEntities = new Set<string>();
        for (const e of events) {
          if (e.entity_refs) {
            for (const r of e.entity_refs) inScopeEntities.add(r);
          }
        }
        entityRefs = Array.from(inScopeEntities);
        firstTsMs = events[0].ts_ms;
        lastTsMs = events[events.length - 1].ts_ms;
      } else {
        // Unscoped: thread-row metadata is the canonical aggregate.
        surfaces = decryptJsonFromColumn<string[]>(
          handle.masterKey,
          "threads",
          threadRow.surfaces
        );
        entityRefs = threadRow.entity_refs
          ? decryptJsonFromColumn<string[]>(
              handle.masterKey,
              "threads",
              threadRow.entity_refs
            )
          : [];
        firstTsMs = threadRow.first_ts_ms;
        lastTsMs = threadRow.last_ts_ms;
      }

      return okResponse({
        status: "ok",
        thread_id: params.thread_id,
        first_ts_ms: firstTsMs,
        last_ts_ms: lastTsMs,
        surfaces,
        entity_refs: entityRefs,
        events: events.map((e) => ({
          event_uuid: e.event_uuid,
          surface: e.surface,
          channel_ref: e.channel_ref,
          side: e.side,
          author_ref: e.author_ref,
          content: e.content,
          content_kind: e.content_kind,
          ts_ms: e.ts_ms,
        })),
      });
    },
  };
}
