import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  type ServeOptions,
  resolveScopes,
  registerToolsWithScopes,
} from "usrcp-local/dist/scope-enforcement.js";
import { openStreamDb, closeStreamDb, type StreamHandle } from "./db/index.js";
import { loadVectorExtension } from "./vector/index.js";
import { makeStitcher } from "./stitch/thread.js";
import { makeLedgerEntityResolver } from "./stitch/entity.js";
import type { EntityResolver } from "./stitch/entity.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import type { PrewarmEvent } from "./surface/prewarm.js";
import { loadEmbedderFromUserDir } from "./config-io.js";
import { streamCapture } from "./tools/stream-capture.js";
import { streamRecall } from "./tools/stream-recall.js";
import { streamThread } from "./tools/stream-thread.js";
import { streamActiveSurface } from "./tools/stream-active-surface.js";
import { streamPrewarm } from "./tools/stream-prewarm.js";
import { streamStatus } from "./tools/stream-status.js";
import { streamSyncPush } from "./tools/stream-sync-push.js";
import { streamSyncPull } from "./tools/stream-sync-pull.js";
import { streamSyncStatus } from "./tools/stream-sync-status.js";
import type { StreamToolDef } from "./tools/types.js";

/**
 * Stream's scope-enforcement options. After PR #64 these are an exact
 * alias for `ServeOptions` from `usrcp-local/dist/scope-enforcement` -
 * both packages route through the same shared wrapper. Kept as a
 * separate name so external consumers that imported
 * `StreamServeOptions` don't break.
 */
export type StreamServeOptions = ServeOptions;

export interface RegisterStreamOptions {
  masterKey: Buffer;
  userDir: string;
  ledger?: Ledger | null;
  // Embedder resolution:
  //   undefined / property absent: load from saved stream-config.toml.
  //                                If that fails or returns null, no
  //                                embedder is wired and recall returns
  //                                no hits.
  //   null:                        explicitly disabled (e.g. tests).
  //   EmbeddingProvider:           use this instance verbatim.
  embedder?: EmbeddingProvider | null;
  serveOptions?: StreamServeOptions;
  // Cloud sync endpoint for stream_sync_push / stream_sync_pull tools.
  // Optional; when absent, those tools throw a clear error on use.
  cloudEndpoint?: string;
  prewarmSummarizer?: (
    events: PrewarmEvent[],
    maxTokens: number
  ) => Promise<string>;
}

export interface StreamRegistration {
  handle: StreamHandle;
  shutdown: () => void;
}

export function registerStreamTools(
  mcpServer: McpServer,
  options: RegisterStreamOptions
): StreamRegistration {
  const handle = openStreamDb(options.userDir, options.masterKey);
  try {
    loadVectorExtension(handle.db);
  } catch (err) {
    console.error(
      "[usrcp-stream] sqlite-vec failed to load; semantic recall will return no hits.",
      err
    );
  }
  const stitcher = makeStitcher(handle);
  // Three-state embedder: explicit value wins; explicit null means off;
  // absent / undefined means "load from saved config" (Codex P1-3).
  const embedder: EmbeddingProvider | null =
    "embedder" in options
      ? (options.embedder ?? null)
      : loadEmbedderFromUserDir(options.masterKey, options.userDir);
  const ledger = options.ledger ?? null;
  // When a Ledger is wired (unified-serve mode), construct the
  // best-effort entity resolver so capture can backfill entity_refs from
  // active projects (Codex P1-4). Standalone mode (no ledger) keeps the
  // resolver null - capture proceeds with explicit entity_refs only.
  const entityResolver: EntityResolver | null = ledger
    ? makeLedgerEntityResolver(ledger)
    : null;

  const serveOpts = options.serveOptions ?? {};
  // Resolve once here so the multi-domain-read tool factories below
  // can use `readScopes` for handler-level scope-wall injection.
  // The wrapper registers the tools via the shared helper.
  const { readScopes } = resolveScopes(serveOpts);

  // Scope-wall injection: multi-domain-read tools receive the allowed
  // surface list so their handlers can post-filter rows. The wrapper
  // below only blocks explicit out-of-scope params; without these
  // injections, an unparameterized recall or thread fetch leaks every
  // surface's events. Reads use readScopes (the new asymmetric flag),
  // not scopes - this is what was buggy in the pre-#61 stream code.
  const defs: StreamToolDef[] = [
    streamCapture(handle, embedder, stitcher, entityResolver),
    streamRecall(handle, embedder, { allowedScopes: readScopes }),
    streamThread(handle, { allowedScopes: readScopes }),
    // global-read tools (stream_active_surface, stream_status) bypass
    // the wrapper's domain check entirely. Without injecting
    // readScopes here, a read-scoped agent could call them and learn
    // metadata about surfaces outside its read allowlist (most-recent
    // surface name, ledger-wide event/thread counts, db_path). Codex
    // round-5 review on PR #61 caught the metadata leak.
    streamActiveSurface(handle, { allowedScopes: readScopes }),
    streamPrewarm(handle, {
      summarizer: options.prewarmSummarizer,
      allowedScopes: readScopes,
    }),
    streamStatus(handle, embedder, { allowedScopes: readScopes }),
  ];

  // Sync tools register only when a Ledger is wired AND a cloud
  // endpoint is provided. Without a ledger we can't sign requests;
  // without an endpoint there's nowhere to push.
  if (ledger && options.cloudEndpoint) {
    defs.push(
      streamSyncPush(handle, { ledger, endpoint: options.cloudEndpoint }),
      streamSyncPull(handle, { ledger, endpoint: options.cloudEndpoint }),
      streamSyncStatus(handle, { endpoint: options.cloudEndpoint })
    );
  }
  // Apply the shared scope-enforcement wrapper. Identical semantics
  // to usrcp-local's createServer; lifted into a shared module in
  // PR #64 so the two enforcement paths can't drift (the structural
  // smell that caused four codex bypass-rounds on PR #61).
  registerToolsWithScopes(mcpServer, defs, serveOpts, ledger ?? null);

  return {
    handle,
    shutdown: () => closeStreamDb(handle),
  };
}

// resolveStreamScopes + outOfScopeResponse were duplicates of the
// usrcp-local helpers - lifted into the shared
// usrcp-local/src/scope-enforcement.ts module in PR #64 and imported
// at the top of this file. The structural smell that caused four
// codex-review rounds on PR #61 is gone.
