import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { Stitcher } from "../stitch/thread.js";
import { captureEvent } from "../capture/ingest.js";
import {
  MAX_STRING_SHORT,
  MAX_STRING_MEDIUM,
  MAX_CONTENT_BYTES,
  MAX_ENTITY_REFS,
} from "../capture/types.js";
import { okResponse, errorResponse, type StreamToolDef } from "./types.js";

export function streamCapture(
  handle: StreamHandle,
  embedder: EmbeddingProvider | null,
  stitcher: Stitcher | null
): StreamToolDef {
  return {
    name: "stream_capture",
    description:
      "Capture one conversational event from any surface into the encrypted stream. " +
      "Both sides of every channel should be captured (set side='inbound' for messages " +
      "addressed to the user, 'outbound' for messages the user or their agent emits, " +
      "'system' for tool calls and other meta events). Returns an event UUID and the " +
      "stitched thread_id (null if no thread linkage was found).",
    kind: "domain-scoped",
    mutating: true,
    scopeOf: (p) => [String(p.surface)],
    inputShape: {
      surface: z.string().min(1).max(MAX_STRING_SHORT),
      channel_ref: z.record(z.string(), z.unknown()),
      side: z.enum(["inbound", "outbound", "system"]),
      author_ref: z.object({
        id: z.string().min(1).max(MAX_STRING_MEDIUM),
        displayName: z.string().max(MAX_STRING_MEDIUM).optional(),
      }),
      content: z.string().min(1).max(MAX_CONTENT_BYTES),
      content_kind: z.enum([
        "text",
        "code",
        "image-caption",
        "tool-call",
        "tool-result",
      ]),
      ts_ms: z.number().int().nonnegative(),
      entity_refs: z
        .array(z.string().max(MAX_STRING_MEDIUM))
        .max(MAX_ENTITY_REFS)
        .optional(),
    },
    handler: async (params) => {
      try {
        const result = await captureEvent(
          {
            handle,
            embedder,
            stitch: stitcher ? (i) => stitcher.stitch(i) : undefined,
          },
          params
        );
        return okResponse({
          status: "ok",
          event_uuid: result.event_uuid,
          thread_id: result.thread_id,
          ingested_at: result.ingested_at,
        });
      } catch (err) {
        return errorResponse("capture_failed", (err as Error).message);
      }
    },
  };
}
