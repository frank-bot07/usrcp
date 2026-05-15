import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ledger } from "usrcp-local/dist/ledger/index.js";
import { openStreamDb, closeStreamDb, type StreamHandle } from "./db/index.js";
import { loadVectorExtension } from "./vector/index.js";
import { makeStitcher } from "./stitch/thread.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import type { PrewarmEvent } from "./surface/prewarm.js";
import { streamCapture } from "./tools/stream-capture.js";
import { streamRecall } from "./tools/stream-recall.js";
import { streamThread } from "./tools/stream-thread.js";
import { streamActiveSurface } from "./tools/stream-active-surface.js";
import { streamPrewarm } from "./tools/stream-prewarm.js";
import { streamStatus } from "./tools/stream-status.js";
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
  embedder?: EmbeddingProvider | null;
  serveOptions?: StreamServeOptions;
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
  const embedder = options.embedder ?? null;
  const ledger = options.ledger ?? null;

  const defs: StreamToolDef[] = [
    streamCapture(handle, embedder, stitcher),
    streamRecall(handle, embedder),
    streamThread(handle),
    streamActiveSurface(handle),
    streamPrewarm(handle, { summarizer: options.prewarmSummarizer }),
    streamStatus(handle, embedder),
  ];

  const serveOpts = options.serveOptions ?? {};
  const scopes =
    serveOpts.scopes && serveOpts.scopes.length > 0 ? serveOpts.scopes : undefined;
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
