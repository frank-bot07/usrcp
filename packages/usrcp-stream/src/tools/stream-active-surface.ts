import type { StreamHandle } from "../db/index.js";
import { getActiveSurface } from "../surface/presence.js";
import { okResponse, type StreamToolDef } from "./types.js";

export function streamActiveSurface(handle: StreamHandle): StreamToolDef {
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
      const active = getActiveSurface(handle);
      return okResponse({
        status: "ok",
        active,
      });
    },
  };
}
