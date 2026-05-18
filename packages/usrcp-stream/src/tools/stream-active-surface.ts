import type { StreamHandle } from "../db/index.js";
import { getActiveSurface } from "../surface/presence.js";
import { okResponse, type StreamToolDef } from "./types.js";

export interface ActiveSurfaceOptions {
  /**
   * Read-scope wall: when set, the active-surface query is filtered
   * to these surfaces. Without this, a read-scoped agent could call
   * stream_active_surface and learn the most-recent surface is one
   * OUTSIDE its read allowlist - a metadata leak about activity the
   * agent isn't authorized to see. Codex round-5 review on PR #61
   * caught this.
   *
   * - undefined => unrestricted (legacy / unscoped agent).
   * - non-empty list => only surfaces in this list are considered.
   *   If the most-recent activity was out of scope, returns null.
   */
  allowedScopes?: string[];
}

export function streamActiveSurface(
  handle: StreamHandle,
  options: ActiveSurfaceOptions = {},
): StreamToolDef {
  return {
    name: "stream_active_surface",
    description:
      "Return the surface (Discord, Cursor, iMessage, etc.) the user has been active on " +
      "most recently within the active window. Returns null if no surface has had recent " +
      "capture activity. Agents should call this at conversation start to know which " +
      "surface they're on.",
    kind: "global-read",
    inputShape: {},
    handler: async () => {
      const active = getActiveSurface(handle, undefined, undefined, {
        allowedSurfaces: options.allowedScopes,
      });
      return okResponse({
        status: "ok",
        active,
      });
    },
  };
}
