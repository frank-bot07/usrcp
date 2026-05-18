import type { StreamHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { okResponse, type StreamToolDef } from "./types.js";

export interface StatusOptions {
  /**
   * Read-scope wall: when set, ledger-wide counts (event_count,
   * thread_count, surface_count, etc.) are filtered to surfaces in
   * this list. Without filtering, a read-scoped agent could call
   * stream_status and learn there are N events across surfaces it
   * has no read access to - a metadata leak. Codex round-5 review
   * on PR #61 caught this.
   *
   * Also suppresses `db_path` in the response (parity with the
   * scoped envelope of usrcp_status on the local side).
   *
   * - undefined => unrestricted (legacy / unscoped agent).
   * - non-empty list => counts include only events/threads/surfaces
   *   tied to these surfaces.
   */
  allowedScopes?: string[];
}

export function streamStatus(
  handle: StreamHandle,
  embedder: EmbeddingProvider | null,
  options: StatusOptions = {},
): StreamToolDef {
  return {
    name: "stream_status",
    description:
      "Report stream ledger health: event count, thread count, surface count, last " +
      "capture timestamp, and which embedding model is currently configured. Useful " +
      "for confirming the package is reachable before relying on it for recall.",
    kind: "global-read",
    inputShape: {},
    handler: async () => {
      const scoped = options.allowedScopes !== undefined;

      // Build a parameterized "surface IN (...)" suffix once. Empty
      // allowlist short-circuits everything to zero (no allowed
      // surfaces means no captureable activity).
      const allowedSurfaces = options.allowedScopes ?? [];
      const hasNoAllowed = scoped && allowedSurfaces.length === 0;
      const placeholders = allowedSurfaces.map(() => "?").join(",");

      const countQuery = (table: "events" | "surface_state") => {
        if (!scoped) {
          return (
            handle.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as {
              c: number;
            }
          ).c;
        }
        if (hasNoAllowed) return 0;
        return (
          handle.db
            .prepare(`SELECT COUNT(*) as c FROM ${table} WHERE surface IN (${placeholders})`)
            .all(...allowedSurfaces)[0] as { c: number }
        ).c;
      };

      const eventCount = countQuery("events");
      const surfaceCount = countQuery("surface_state");

      // Thread count is intentionally NOT scope-filtered: threads can
      // span multiple surfaces, so "threads visible to this scope"
      // is the count of threads with at least one event in scope.
      // When scoped we expose that instead of the ledger-wide total.
      const threadCount = !scoped
        ? (handle.db.prepare("SELECT COUNT(*) as c FROM threads").get() as { c: number }).c
        : hasNoAllowed
          ? 0
          : (
              handle.db
                .prepare(
                  `SELECT COUNT(DISTINCT t.thread_id) as c FROM threads t
                   JOIN events e ON e.thread_id = t.thread_id
                   WHERE e.surface IN (${placeholders})`,
                )
                .all(...allowedSurfaces)[0] as { c: number }
            ).c;

      const lastTs = !scoped
        ? (
            handle.db.prepare("SELECT MAX(ts_ms) as t FROM events").get() as {
              t: number | null;
            }
          ).t
        : hasNoAllowed
          ? null
          : (
              handle.db
                .prepare(`SELECT MAX(ts_ms) as t FROM events WHERE surface IN (${placeholders})`)
                .all(...allowedSurfaces)[0] as { t: number | null }
            ).t;

      const embeddingCount = !scoped
        ? (
            handle.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as {
              c: number;
            }
          ).c
        : hasNoAllowed
          ? 0
          : (
              // events.embedding_id -> embeddings.id is the FK (each event
              // optionally points at its embedding row). When scoped we count
              // embeddings reachable via in-scope events.
              handle.db
                .prepare(
                  `SELECT COUNT(*) as c FROM embeddings em
                   JOIN events e ON e.embedding_id = em.id
                   WHERE e.surface IN (${placeholders})`,
                )
                .all(...allowedSurfaces)[0] as { c: number }
            ).c;

      // Scope-aware envelope: parity with usrcp_status on the local
      // side, which adds `scoped: true` + `allowed_*` and omits the
      // unscoped path/totals.
      if (scoped) {
        return okResponse({
          status: "ok",
          scoped: true,
          allowed_surfaces: allowedSurfaces,
          event_count: eventCount,
          thread_count: threadCount,
          surface_count: surfaceCount,
          embedding_count: embeddingCount,
          last_capture_ms: lastTs,
          embedding_model: embedder?.model ?? null,
          embedding_dims: embedder?.dims ?? null,
          vector_backend: "sqlite-vec",
        });
      }

      return okResponse({
        status: "ok",
        event_count: eventCount,
        thread_count: threadCount,
        surface_count: surfaceCount,
        embedding_count: embeddingCount,
        last_capture_ms: lastTs,
        embedding_model: embedder?.model ?? null,
        embedding_dims: embedder?.dims ?? null,
        vector_backend: "sqlite-vec",
        db_path: handle.dbPath,
      });
    },
  };
}
