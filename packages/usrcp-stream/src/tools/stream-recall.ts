import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { normalize } from "../embeddings/provider.js";
import { vectorSearch } from "../vector/search.js";
import {
  MAX_STRING_SHORT,
  MAX_CONTENT_BYTES,
} from "../capture/types.js";
import { okResponse, errorResponse, type StreamToolDef } from "./types.js";

const MAX_SEARCH_QUERY = 1000;

export interface StreamRecallOptions {
  // When set by registerStreamTools, restricts recall results to events
  // on these surfaces. Acts as a server-side scope wall on multi-domain
  // reads where the caller didn't volunteer a surface filter.
  allowedScopes?: string[];
}

export function streamRecall(
  handle: StreamHandle,
  embedder: EmbeddingProvider | null,
  options: StreamRecallOptions = {}
): StreamToolDef {
  return {
    name: "stream_recall",
    description:
      "Semantically recall captured events across surfaces. Returns the top-K events " +
      "ranked by cosine similarity to the query string, with decrypted snippets. Use " +
      "this when you need 'what did the user say about X recently' - the keyword/blind " +
      "index in usrcp_search_timeline does NOT do semantic recall.",
    kind: "multi-domain-read",
    scopeOf: (p) => (p.surface ? [String(p.surface)] : "all"),
    inputShape: {
      query: z.string().min(1).max(MAX_SEARCH_QUERY),
      surface: z.string().min(1).max(MAX_STRING_SHORT).optional(),
      since_ms: z.number().int().nonnegative().optional(),
      until_ms: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(50).optional(),
      min_score: z.number().min(-1).max(1).optional(),
    },
    handler: async (params) => {
      if (!embedder) {
        return okResponse({
          status: "no_embedder_configured",
          hits: [],
          message:
            "No embedding provider is configured. Run `usrcp-stream init` to enable semantic recall.",
        });
      }
      try {
        const queryVec = normalize(await embedder.embed(params.query));
        const hits = vectorSearch(handle, queryVec, {
          dims: embedder.dims,
          surface: params.surface,
          // Scope wall: when the caller did not pin a surface AND the
          // server is scoped, only consider events on the allowed
          // surfaces. params.surface taking precedence is fine because
          // the registerStreamTools wrapper has already rejected
          // out-of-scope params.surface values.
          surfaces:
            !params.surface && options.allowedScopes && options.allowedScopes.length > 0
              ? options.allowedScopes
              : undefined,
          since_ms: params.since_ms,
          until_ms: params.until_ms,
          limit: params.limit ?? 10,
          min_score: params.min_score,
        });
        return okResponse({
          status: "ok",
          hits: hits.map((h) => ({
            event_uuid: h.event_uuid,
            surface: h.surface,
            channel_ref: h.channel_ref,
            side: h.side,
            ts_ms: h.ts_ms,
            score: h.score,
            snippet_decrypted: h.snippet_decrypted.slice(0, MAX_CONTENT_BYTES),
          })),
        });
      } catch (err) {
        return errorResponse("recall_failed", (err as Error).message);
      }
    },
  };
}
