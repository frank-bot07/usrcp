import type { StreamHandle } from "../db/index.js";
import { decryptFromColumn } from "../db/encrypted-row.js";
import { DEFAULT_PREWARM, type PrewarmConfig } from "../config.js";

export interface PrewarmEvent {
  surface: string;
  content: string;
  ts_ms: number;
}

export interface PrewarmResult {
  summary: string;
  source_surfaces: string[];
  events_count: number;
  decay_ms: number;
}

export interface PrewarmOptions {
  target_surface: string;
  window_min?: number;
  max_tokens?: number;
  // CLI/serve injects a Haiku-backed summarizer when an ANTHROPIC_API_KEY
  // is configured; the default fallback is a chronological bullet list
  // so prewarm stays deterministic and offline-safe by default.
  summarizer?: (
    events: PrewarmEvent[],
    maxTokens: number
  ) => Promise<string>;
  now?: number;
  /**
   * Read-scope wall: when set, only events from these surfaces are
   * returned in the handoff. Without this, an agent scoped to
   * `--read-scopes=discord` could call prewarm with target_surface=discord
   * and the handler's deliberate cross-surface read would leak Telegram
   * or Slack content (prewarm pulls events from surfaces OTHER than the
   * target by design). The wrapper enforces "you can read target_surface";
   * `allowedSurfaces` enforces "and the cross-surface pull stays in your
   * read allowlist."
   *
   * Codex round-4 review on PR #61 caught the leak.
   *
   * - undefined => unrestricted (legacy / unscoped agent).
   * - non-empty list => intersect with the "surface != target_surface"
   *   query. Empty list means no other surfaces are allowed and prewarm
   *   returns the no-activity message.
   */
  allowedSurfaces?: string[];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function prewarm(
  handle: StreamHandle,
  options: PrewarmOptions,
  config: PrewarmConfig = DEFAULT_PREWARM
): Promise<PrewarmResult> {
  const windowMin = options.window_min ?? config.window_min;
  const windowMs = windowMin * 60 * 1000;
  const now = options.now ?? Date.now();
  const since = now - windowMs;

  const threadRows = handle.db
    .prepare(
      `SELECT DISTINCT thread_id FROM events
       WHERE surface = ? AND thread_id IS NOT NULL AND ts_ms >= ?`
    )
    .all(options.target_surface, now - ONE_DAY_MS) as { thread_id: string }[];

  // Pre-compute the read-scope filter once. When the caller provided
  // `allowedSurfaces`, both branches below intersect their "other surfaces"
  // result against that allowlist. The wrapper has already verified
  // target_surface is in the readScopes set, but the cross-surface
  // pull is what leaks without this.
  const hasScopeWall = options.allowedSurfaces !== undefined;
  const allowedOtherSurfaces = hasScopeWall
    ? (options.allowedSurfaces ?? []).filter((s) => s !== options.target_surface)
    : null;
  const scopePlaceholders = allowedOtherSurfaces
    ? allowedOtherSurfaces.map(() => "?").join(",")
    : "";

  let rawRows: { surface: string; content: string; ts_ms: number }[] = [];

  // Short-circuit: if a scope wall is set and the only allowed surface
  // IS the target, there's nothing to pull from "other" surfaces. Skip
  // both DB queries to avoid an `IN ()` that some SQLite builds treat
  // as a syntax error.
  if (hasScopeWall && allowedOtherSurfaces!.length === 0) {
    rawRows = [];
  } else if (threadRows.length > 0) {
    const threadPlaceholders = threadRows.map(() => "?").join(",");
    const scopeClause = hasScopeWall
      ? ` AND surface IN (${scopePlaceholders})`
      : "";
    const params: unknown[] = [
      ...threadRows.map((r) => r.thread_id),
      options.target_surface,
      since,
      ...(allowedOtherSurfaces ?? []),
    ];
    rawRows = handle.db
      .prepare(
        `SELECT surface, content, ts_ms FROM events
         WHERE thread_id IN (${threadPlaceholders})
           AND surface != ?
           AND ts_ms >= ?` +
          scopeClause +
        `
         ORDER BY ts_ms ASC`
      )
      .all(...params) as typeof rawRows;
  }

  // Fallback: no thread linkage yet - pull anything recent from other surfaces.
  if (rawRows.length === 0 && !(hasScopeWall && allowedOtherSurfaces!.length === 0)) {
    const scopeClause = hasScopeWall
      ? ` AND surface IN (${scopePlaceholders})`
      : "";
    const params: unknown[] = [
      options.target_surface,
      since,
      ...(allowedOtherSurfaces ?? []),
    ];
    rawRows = handle.db
      .prepare(
        `SELECT surface, content, ts_ms FROM events
         WHERE surface != ? AND ts_ms >= ?` +
          scopeClause +
        `
         ORDER BY ts_ms ASC`
      )
      .all(...params) as typeof rawRows;
  }

  const events: PrewarmEvent[] = rawRows.map((r) => ({
    surface: r.surface,
    content: decryptFromColumn(handle.masterKey, "events", r.content),
    ts_ms: r.ts_ms,
  }));

  const sourceSurfaces = Array.from(new Set(events.map((e) => e.surface)));
  const maxTokens = options.max_tokens ?? config.max_tokens;

  let summary: string;
  if (events.length === 0) {
    summary = "(no recent activity to pre-warm)";
  } else if (options.summarizer) {
    try {
      summary = await options.summarizer(events, maxTokens);
    } catch {
      summary = bulletList(events);
    }
  } else {
    summary = bulletList(events);
  }

  return {
    summary,
    source_surfaces: sourceSurfaces,
    events_count: events.length,
    decay_ms: config.decay_ms,
  };
}

function bulletList(events: PrewarmEvent[]): string {
  return events
    .map(
      (e) =>
        `- [${e.surface} @ ${new Date(e.ts_ms).toISOString()}] ${e.content.slice(0, 240)}`
    )
    .join("\n");
}
