import type { StreamHandle } from "../db/index.js";
import { syncStreamStatus } from "../sync.js";
import { okResponse, type StreamToolDef } from "./types.js";

export interface StreamSyncStatusOptions {
  endpoint?: string;
}

export function streamSyncStatus(
  handle: StreamHandle,
  options: StreamSyncStatusOptions = {}
): StreamToolDef {
  return {
    name: "stream_sync_status",
    description:
      "Report cloud sync state: last_pushed_local_id, last_pulled_server_seq, pending_events_to_push. " +
      "Read-only; always available regardless of scopes.",
    kind: "global-read",
    inputShape: {},
    handler: async () => {
      const result = syncStreamStatus(handle, { endpoint: options.endpoint });
      return okResponse({ status: "ok", ...result });
    },
  };
}
