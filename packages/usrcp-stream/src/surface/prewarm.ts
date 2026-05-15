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

  let rawRows: { surface: string; content: string; ts_ms: number }[] = [];

  if (threadRows.length > 0) {
    const placeholders = threadRows.map(() => "?").join(",");
    const params: unknown[] = [
      ...threadRows.map((r) => r.thread_id),
      options.target_surface,
      since,
    ];
    rawRows = handle.db
      .prepare(
        `SELECT surface, content, ts_ms FROM events
         WHERE thread_id IN (${placeholders})
           AND surface != ?
           AND ts_ms >= ?
         ORDER BY ts_ms ASC`
      )
      .all(...params) as typeof rawRows;
  }

  // Fallback: no thread linkage yet — pull anything recent from other surfaces.
  if (rawRows.length === 0) {
    rawRows = handle.db
      .prepare(
        `SELECT surface, content, ts_ms FROM events
         WHERE surface != ? AND ts_ms >= ?
         ORDER BY ts_ms ASC`
      )
      .all(options.target_surface, since) as typeof rawRows;
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
