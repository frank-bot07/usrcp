import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ledger } from "usrcp-local/dist/ledger/index.js";
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

export interface StreamServeOptions {
  scopes?: string[];
  readonly?: boolean;
  noAudit?: boolean;
  agentId?: string;
}

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
  const scopes =
    serveOpts.scopes && serveOpts.scopes.length > 0 ? serveOpts.scopes : undefined;

  // Scope-wall injection: multi-domain-read tools receive the allowed
  // surface list so their handlers can post-filter rows. The wrapper
  // below only blocks explicit out-of-scope params; without these
  // injections, an unparameterized recall or thread fetch leaks every
  // surface's events.
  const defs: StreamToolDef[] = [
    streamCapture(handle, embedder, stitcher, entityResolver),
    streamRecall(handle, embedder, { allowedScopes: scopes }),
    streamThread(handle, { allowedScopes: scopes }),
    streamActiveSurface(handle),
    streamPrewarm(handle, { summarizer: options.prewarmSummarizer }),
    streamStatus(handle, embedder),
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
  const scopedMode =
    scopes !== undefined ||
    serveOpts.readonly === true ||
    serveOpts.noAudit === true ||
    serveOpts.agentId !== undefined;
  const agentId = serveOpts.agentId ?? "unidentified";

  for (const def of defs) {
    if (serveOpts.readonly && def.mutating) continue;

    const wrapped = async (params: unknown) => {
      if (scopedMode && ledger) {
        try {
          ledger.logAudit(
            `mcp_call:${def.name}`,
            scopes ?? "*",
            undefined,
            undefined,
            undefined,
            agentId
          );
        } catch {
          // Ledger audit is best-effort here; a sibling-package audit
          // failure must not bring down the MCP call.
        }
      }

      if (scopes) {
        if (def.kind === "global-mutation") {
          return outOfScopeResponse(def.name, ["<global>"], scopes);
        }
        if (def.kind === "domain-scoped" && def.scopeOf) {
          const requested = def.scopeOf(params) as string[];
          const out = requested.filter((d) => !scopes.includes(d));
          if (out.length > 0) {
            return outOfScopeResponse(def.name, out, scopes);
          }
        }
        if (def.kind === "multi-domain-read" && def.scopeOf) {
          const requested = def.scopeOf(params);
          if (requested !== "all") {
            const out = (requested as string[]).filter(
              (d) => !scopes.includes(d)
            );
            if (out.length > 0) {
              return outOfScopeResponse(def.name, out, scopes);
            }
          }
        }
      }

      return def.handler(params);
    };

    mcpServer.tool(def.name, def.description, def.inputShape, wrapped);
  }

  return {
    handle,
    shutdown: () => closeStreamDb(handle),
  };
}

function outOfScopeResponse(
  toolName: string,
  requested: string[],
  allowed: string[]
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "out_of_scope",
            error: "OUT_OF_SCOPE",
            tool: toolName,
            requested_domains: requested,
            allowed_domains: allowed,
            message:
              `Tool '${toolName}' was called with out-of-scope target(s): [${requested.join(", ")}]. ` +
              `This MCP server is scoped to: [${allowed.join(", ")}]. ` +
              `Re-launch with broader --scopes or call from an unscoped server.`,
          },
          null,
          2
        ),
      },
    ],
  };
}
