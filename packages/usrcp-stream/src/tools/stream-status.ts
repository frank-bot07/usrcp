import type { StreamHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { okResponse, type StreamToolDef } from "./types.js";

export function streamStatus(
  handle: StreamHandle,
  embedder: EmbeddingProvider | null
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
      const events = handle.db
        .prepare("SELECT COUNT(*) as c FROM events")
        .get() as { c: number };
      const threads = handle.db
        .prepare("SELECT COUNT(*) as c FROM threads")
        .get() as { c: number };
      const surfaces = handle.db
        .prepare("SELECT COUNT(*) as c FROM surface_state")
        .get() as { c: number };
      const lastTs = handle.db
        .prepare("SELECT MAX(ts_ms) as t FROM events")
        .get() as { t: number | null };
      const embeddings = handle.db
        .prepare("SELECT COUNT(*) as c FROM embeddings")
        .get() as { c: number };

      return okResponse({
        status: "ok",
        event_count: events.c,
        thread_count: threads.c,
        surface_count: surfaces.c,
        embedding_count: embeddings.c,
        last_capture_ms: lastTs.t,
        embedding_model: embedder?.model ?? null,
        embedding_dims: embedder?.dims ?? null,
        vector_backend: "sqlite-vec",
        db_path: handle.dbPath,
      });
    },
  };
}
