import type { StreamHandle } from "../db/index.js";
import { decryptJsonFromColumn } from "../db/encrypted-row.js";
import { DEFAULT_PRESENCE, type PresenceConfig } from "../config.js";
import type { ChannelRef } from "../capture/types.js";

export interface ActiveSurface {
  surface: string;
  channel_ref: ChannelRef;
  last_seen_ms: number;
  heartbeat_ms: number;
}

interface SurfaceStateRow {
  surface: string;
  channel_ref: string;
  last_seen_ms: number;
  heartbeat_ms: number;
}

export function getActiveSurface(
  handle: StreamHandle,
  config: PresenceConfig = DEFAULT_PRESENCE,
  now: number = Date.now()
): ActiveSurface | null {
  const earliest = now - config.active_window_ms;
  const row = handle.db
    .prepare(
      `SELECT surface, channel_ref, last_seen_ms, heartbeat_ms
       FROM surface_state
       WHERE last_seen_ms >= ?
       ORDER BY last_seen_ms DESC
       LIMIT 1`
    )
    .get(earliest) as SurfaceStateRow | undefined;
  if (!row) return null;
  return {
    surface: row.surface,
    channel_ref: decryptJsonFromColumn<ChannelRef>(
      handle.masterKey,
      "surface_state",
      row.channel_ref
    ),
    last_seen_ms: row.last_seen_ms,
    heartbeat_ms: row.heartbeat_ms,
  };
}

export function listSurfaces(handle: StreamHandle): { surface: string; last_seen_ms: number }[] {
  return handle.db
    .prepare(
      `SELECT surface, last_seen_ms FROM surface_state ORDER BY last_seen_ms DESC`
    )
    .all() as { surface: string; last_seen_ms: number }[];
}
