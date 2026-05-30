import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import type { Ledger } from "usrcp-local/ledger";
import { syncStreamPush } from "../sync.js";
import { okResponse, errorResponse, type StreamToolDef } from "./types.js";

export interface StreamSyncPushOptions {
  ledger: Ledger;
  endpoint?: string;
}

export function streamSyncPush(
  handle: StreamHandle,
  options: StreamSyncPushOptions
): StreamToolDef {
  return {
    name: "stream_sync_push",
    description:
      "Push local stream events (and their encrypted embeddings) to the configured usrcp-cloud endpoint. " +
      "Idempotent: events the server has already seen are reported as duplicates without re-inserting. " +
      "Advances the local sync cursor on success. Refused when the MCP server runs with --scopes.",
    kind: "global-mutation",
    mutating: true,
    inputShape: {
      limit: z.number().int().positive().max(500).optional(),
    },
    handler: async (params) => {
      try {
        const result = await syncStreamPush(handle, options.ledger, {
          endpoint: options.endpoint,
          limit: params.limit,
        });
        return okResponse({ status: "ok", ...result });
      } catch (err) {
        return errorResponse("sync_push_failed", (err as Error).message);
      }
    },
  };
}
