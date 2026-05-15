import { z } from "zod";
import type { StreamHandle } from "../db/index.js";
import { prewarm, type PrewarmEvent } from "../surface/prewarm.js";
import { MAX_STRING_SHORT } from "../capture/types.js";
import { okResponse, errorResponse, type StreamToolDef } from "./types.js";

export interface PrewarmToolOptions {
  // Injected by the standalone server / CLI when ANTHROPIC_API_KEY is set.
  // The lazy-import integration path leaves this undefined and ships the
  // default bullet-list summarizer.
  summarizer?: (events: PrewarmEvent[], maxTokens: number) => Promise<string>;
}

export function streamPrewarm(
  handle: StreamHandle,
  options: PrewarmToolOptions = {}
): StreamToolDef {
  return {
    name: "stream_prewarm",
    description:
      "Build a context handoff summary when the user pivots between surfaces. Pulls " +
      "recent events from other surfaces that share a thread with the target surface, " +
      "or falls back to any recent activity if no thread linkage exists yet. The " +
      "returned summary should be prepended to the assistant's next response on the " +
      "target surface.",
    kind: "domain-scoped",
    scopeOf: (p) => [String(p.target_surface)],
    inputShape: {
      target_surface: z.string().min(1).max(MAX_STRING_SHORT),
      window_min: z.number().int().positive().max(720).optional(),
      max_tokens: z.number().int().positive().max(8192).optional(),
    },
    handler: async (params) => {
      try {
        const result = await prewarm(handle, {
          target_surface: params.target_surface,
          window_min: params.window_min,
          max_tokens: params.max_tokens,
          summarizer: options.summarizer,
        });
        return okResponse({ status: "ok", ...result });
      } catch (err) {
        return errorResponse("prewarm_failed", (err as Error).message);
      }
    },
  };
}
