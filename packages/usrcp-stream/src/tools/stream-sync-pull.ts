import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import type { Ledger } from "usrcp-local/dist/ledger/index.js";
import { syncStreamPull } from "../sync.js";
import { okResponse, errorResponse, type StreamToolDef } from "./types.js";

export interface StreamSyncPullOptions {
  ledger: Ledger;
  endpoint?: string;
}

export function streamSyncPull(
  handle: StreamHandle,
  options: StreamSyncPullOptions
): StreamToolDef {
  return {
    name: "stream_sync_pull",
    description:
      "Pull stream events from the configured usrcp-cloud endpoint and re-stitch threads locally. " +
      "Dedupes by event_uuid; decrypts embeddings on the way in and re-indexes them in sqlite-vec. " +
      "Advances the local sync cursor on success. Refused when the MCP server runs with --scopes.",
    kind: "global-mutation",
    mutating: true,
    inputShape: {
      limit: z.number().int().positive().max(500).optional(),
    },
    handler: async (params) => {
      try {
        const result = await syncStreamPull(handle, options.ledger, {
          endpoint: options.endpoint,
          limit: params.limit,
        });
        return okResponse({ status: "ok", ...result });
      } catch (err) {
        return errorResponse("sync_pull_failed", (err as Error).message);
      }
    },
  };
}
