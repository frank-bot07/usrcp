import type { z } from "zod";

// Tool surface mirrors usrcp-local/src/server.ts:60-65 so stream tools
// flow through the same scope-enforcement wrapper.
// global-mutation is refused outright when serveOptions.scopes is set
// (it touches all surfaces; a domain-scoped server shouldn't be allowed
// to trigger it). Used by the cloud-sync tools.
export type ToolKind =
  | "global-read"
  | "global-mutation"
  | "domain-scoped"
  | "multi-domain-read";

export interface StreamToolDef {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  // The handler emits MCP's `content` envelope. Tool definitions never
  // throw on caller-shaped errors; they return a JSON-shaped text block.
  handler: (params: any) => Promise<{
    content: { type: "text"; text: string }[];
  }>;
  kind: ToolKind;
  mutating?: boolean;
  // Returns the domain(s) the call would touch. Required for
  // domain-scoped; optional for multi-domain-read (returns "all" when
  // unconstrained).
  scopeOf?: (params: any) => string[] | "all";
}

export function okResponse(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function errorResponse(error: string, detail?: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { status: "error", error, detail: detail ?? null },
          null,
          2
        ),
      },
    ],
  };
}
