import type { Ledger } from "usrcp-local/dist/ledger/index.js";
import { openStreamDb, closeStreamDb, type StreamHandle } from "./db/index.js";
import { loadVectorExtension } from "./vector/index.js";
import { makeStitcher } from "./stitch/thread.js";
import {
  makeLedgerEntityResolver,
  type EntityResolver,
} from "./stitch/entity.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { loadEmbedderFromUserDir } from "./config-io.js";
import { captureEvent } from "./capture/ingest.js";
import type { CapturedEvent } from "./capture/types.js";

export interface StreamCaptureClientOptions {
  // Optional Ledger. When present, the client constructs a best-effort
  // entity resolver that backfills entity_refs from active projects
  // (same wiring as registerStreamTools).
  ledger?: Ledger | null;
  // Three-state embedder, matching registerStreamTools:
  //   omitted / undefined: load from saved stream-config.toml.
  //   null:                explicitly disabled (recall returns no hits).
  //   EmbeddingProvider:   use this instance verbatim.
  embedder?: EmbeddingProvider | null;
}

export interface StreamCaptureClient {
  capture(event: unknown): Promise<CapturedEvent>;
  close(): void;
  readonly handle: StreamHandle;
}

// Factory for adapter packages that want to write into the encrypted
// stream DB without spinning up the full MCP server. Mirrors the setup
// chain inside registerStreamTools so an adapter using this client and a
// caller using the MCP stream_capture tool end up writing the same
// events with the same stitching and the same encryption.
export function createStreamCaptureClient(
  masterKey: Buffer,
  userDir: string,
  options: StreamCaptureClientOptions = {}
): StreamCaptureClient {
  const handle = openStreamDb(userDir, masterKey);
  try {
    loadVectorExtension(handle.db);
  } catch (err) {
    console.error(
      "[usrcp-stream] sqlite-vec failed to load; capture proceeds, but recall will return no hits.",
      err
    );
  }
  const stitcher = makeStitcher(handle);
  const embedder: EmbeddingProvider | null =
    "embedder" in options
      ? (options.embedder ?? null)
      : loadEmbedderFromUserDir(masterKey, userDir);
  const ledger = options.ledger ?? null;
  const entityResolver: EntityResolver | null = ledger
    ? makeLedgerEntityResolver(ledger)
    : null;

  return {
    handle,
    capture(event: unknown): Promise<CapturedEvent> {
      return captureEvent(
        {
          handle,
          embedder,
          entityResolver,
          stitch: (i) => stitcher.stitch(i),
        },
        event
      );
    },
    close(): void {
      closeStreamDb(handle);
    },
  };
}
