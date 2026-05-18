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
  /** Legacy symmetric domain allowlist. Same semantics as usrcp-local. */
  scopes?: string[];
  /** Asymmetric read allowlist (added alongside usrcp-local PR #61). */
  readScopes?: string[];
  /** Asymmetric write allowlist (added alongside usrcp-local PR #61). */
  writeScopes?: string[];
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
  const { readScopes, writeScopes } = resolveStreamScopes(serveOpts);

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
    streamActiveSurface(handle),
    // streamPrewarm needs the read allowlist too: the wrapper only
    // checks target_surface, but the handler intentionally pulls from
    // OTHER surfaces. Without the explicit cross-surface filter, a
    // read-scoped agent could call prewarm and receive content from
    // out-of-scope surfaces (codex round-4 review on PR #61).
    streamPrewarm(handle, {
      summarizer: options.prewarmSummarizer,
      allowedScopes: readScopes,
    }),
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
  // A mutating tool is stripped at registration when writes are
  // disallowed across all domains (`writeScopes === []`, the same
  // signal as `--readonly`).
  const writesAllDenied = writeScopes !== undefined && writeScopes.length === 0;

  const scopedMode =
    readScopes !== undefined ||
    writeScopes !== undefined ||
    serveOpts.noAudit === true ||
    serveOpts.agentId !== undefined;
  const agentId = serveOpts.agentId ?? "unidentified";

  // Compact display string for the audit row: distinguishes "all"
  // ("*") from "[a,b,c]" without coupling the audit format to the
  // read/write split.
  const formatScopeArr = (s: string[] | undefined): string =>
    s === undefined ? "*" : s.length === 0 ? "[]" : `[${s.join(",")}]`;
  const auditScopeRepr = `read=${formatScopeArr(readScopes)};write=${formatScopeArr(writeScopes)}`;

  for (const def of defs) {
    if (writesAllDenied && def.mutating) continue;

    const wrapped = async (params: unknown) => {
      if (scopedMode && ledger) {
        try {
          ledger.logAudit(
            `mcp_call:${def.name}`,
            auditScopeRepr,
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

      // Mutating tools check writeScopes; reads check readScopes.
      // Distinguishing the two is what enables asymmetric permissions
      // ("read every surface, write only to {coding}").
      const effective = def.mutating ? writeScopes : readScopes;

      if (effective) {
        if (def.kind === "global-mutation") {
          return outOfScopeResponse(def.name, ["<global>"], effective);
        }
        if (def.kind === "domain-scoped" && def.scopeOf) {
          const requested = def.scopeOf(params) as string[];
          const out = requested.filter((d) => !effective.includes(d));
          if (out.length > 0) {
            return outOfScopeResponse(def.name, out, effective);
          }
        }
        if (def.kind === "multi-domain-read" && def.scopeOf) {
          const requested = def.scopeOf(params);
          if (requested !== "all") {
            const out = (requested as string[]).filter(
              (d) => !effective.includes(d)
            );
            if (out.length > 0) {
              return outOfScopeResponse(def.name, out, effective);
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

/**
 * Mirrors `resolveScopes` from usrcp-local. Kept inline rather than
 * imported so this package doesn't deepen its coupling to a private
 * helper across the version boundary. The semantics MUST stay in
 * sync with usrcp-local's resolver (legacy --scopes is a symmetric
 * shortcut; --read-scopes alone implies "no writes"; --readonly
 * always wins; writeScopes ⊆ readScopes when both are restrictive;
 * empty-array writeScopes is the "no writes" sentinel and is NOT
 * normalized; legacy --scopes=[] is empty-as-unrestricted both ways).
 */
function resolveStreamScopes(opts: StreamServeOptions): {
  readScopes: string[] | undefined;
  writeScopes: string[] | undefined;
} {
  if (
    opts.scopes !== undefined &&
    (opts.readScopes !== undefined || opts.writeScopes !== undefined)
  ) {
    throw new Error(
      "scopes is mutually exclusive with readScopes / writeScopes. " +
        "Use scopes alone (symmetric) OR the asymmetric pair.",
    );
  }

  const legacyScopes =
    opts.scopes !== undefined && opts.scopes.length > 0 ? opts.scopes : undefined;

  let readScopes: string[] | undefined = opts.readScopes;
  let writeScopes: string[] | undefined = opts.writeScopes;

  if (legacyScopes !== undefined) {
    readScopes = legacyScopes;
    writeScopes = legacyScopes;
  }

  if (
    opts.readScopes !== undefined &&
    opts.writeScopes === undefined &&
    opts.scopes === undefined
  ) {
    writeScopes = [];
  }

  if (opts.readonly === true) {
    writeScopes = [];
  }

  if (readScopes !== undefined && readScopes.length === 0) {
    readScopes = undefined;
  }

  if (
    writeScopes !== undefined &&
    writeScopes.length > 0 &&
    readScopes !== undefined
  ) {
    const outOfRead = writeScopes.filter((d) => !readScopes!.includes(d));
    if (outOfRead.length > 0) {
      throw new Error(
        `writeScopes contains domains not in readScopes: [${outOfRead.join(", ")}]. ` +
          "Writes require read access on the same domain.",
      );
    }
  }

  return { readScopes, writeScopes };
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
