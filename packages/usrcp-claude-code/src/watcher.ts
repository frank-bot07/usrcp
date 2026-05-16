/**
 * Poll-based file tailer for Claude Code session JSONLs.
 *
 * Why polling: fs.watch on macOS is flaky (per Node docs and our
 * own iMessage adapter's avoidance of it). Polling every 2s is more
 * than fast enough for capture latency and keeps the implementation
 * dependency-free.
 *
 * For each allowlisted project (cwd), we look up the encoded directory
 * under ~/.claude/projects/, scan for *.jsonl files, and tail each
 * from its stored byte offset. Lines are parsed JSON; mapTurnToStreamEvent
 * decides whether to dispatch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  encodeProjectDir,
  setOffset,
  flushOffsets,
  getClaudeProjectsDir,
  type ClaudeCodeConfig,
} from "./config.js";
import { mapTurnToStreamEvent, type StreamCaptureEvent } from "./capture.js";

export interface StreamCaptureClientLike {
  capture(event: StreamCaptureEvent): Promise<{
    event_uuid: string;
    thread_id: string | null;
    ingested_at: number;
  }>;
}

export interface WatcherOptions {
  pollIntervalMs?: number;
  /** Override the ~/.claude/projects/ root for tests. */
  projectsDir?: string;
  /** Hook for tests to observe what the watcher did per tick. */
  onTickStats?: (stats: TickStats) => void;
}

export interface TickStats {
  filesScanned: number;
  linesProcessed: number;
  eventsCaptured: number;
  linesSkipped: number;
  errors: number;
  truncationsDetected: number;
}

export interface Watcher {
  /** Run a single poll tick. Tests call this directly. */
  poll(): Promise<TickStats>;
  /** Start the polling loop. Returns a stop function. */
  start(): () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export function makeWatcher(
  config: ClaudeCodeConfig,
  client: StreamCaptureClientLike,
  options: WatcherOptions = {}
): Watcher {
  const projectsRoot = options.projectsDir ?? getClaudeProjectsDir();
  const pollInterval =
    options.pollIntervalMs ?? config.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;

  async function poll(): Promise<TickStats> {
    const stats: TickStats = {
      filesScanned: 0,
      linesProcessed: 0,
      eventsCaptured: 0,
      linesSkipped: 0,
      errors: 0,
      truncationsDetected: 0,
    };

    for (const project of config.allowlisted_projects) {
      const dir = path.join(projectsRoot, encodeProjectDir(project));
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        // Project not yet active on disk - silently skip this tick.
        continue;
      }

      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        let size: number;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }
        const stored = config.file_offsets[file] ?? 0;
        let startOffset = stored;
        if (size < stored) {
          // File shrunk. Treat as fresh and re-scan from start; offset
          // tracking only makes sense over an append-only file.
          stats.truncationsDetected++;
          console.error(
            `[usrcp-claude-code] file shrunk (size ${size} < stored offset ${stored}), resetting offset: ${file}`
          );
          startOffset = 0;
        }
        if (size === startOffset) continue;
        stats.filesScanned++;

        let consumed = startOffset;
        let buf: Buffer;
        try {
          const fd = fs.openSync(file, "r");
          try {
            const len = size - startOffset;
            buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, startOffset);
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          stats.errors++;
          console.error(
            `[usrcp-claude-code] read error on ${file}: ${err instanceof Error ? err.message : err}`
          );
          continue;
        }

        // Split on \n. Anything after the final \n is a partial line;
        // leave it for the next tick by NOT advancing past it.
        const text = buf.toString("utf-8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl < 0) {
          // No complete line yet; wait.
          continue;
        }
        const complete = text.slice(0, lastNl);
        consumed = startOffset + Buffer.byteLength(complete, "utf-8") + 1; // +1 for the \n

        const lines = complete.split("\n");
        for (const line of lines) {
          if (line.length === 0) continue;
          stats.linesProcessed++;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            stats.errors++;
            continue;
          }
          const result = mapTurnToStreamEvent(parsed);
          if (result.kind === "skip") {
            stats.linesSkipped++;
            continue;
          }
          try {
            await client.capture(result.event);
            stats.eventsCaptured++;
          } catch (err) {
            stats.errors++;
            console.error(
              `[usrcp-claude-code] stream capture error on ${file}: ${err instanceof Error ? err.message : err}`
            );
            // Stop on first error within a file to preserve ordering
            // and avoid advancing the offset past unwritten events.
            break;
          }
        }

        setOffset(file, consumed, config);
      }
    }

    options.onTickStats?.(stats);
    return stats;
  }

  function start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (stopped) return;
      try {
        await poll();
      } catch (err) {
        console.error(
          `[usrcp-claude-code] poll cycle error: ${err instanceof Error ? err.message : err}`
        );
      }
      if (stopped) return;
      timer = setTimeout(loop, pollInterval);
    };
    loop();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flushOffsets();
    };
  }

  return { poll, start };
}
