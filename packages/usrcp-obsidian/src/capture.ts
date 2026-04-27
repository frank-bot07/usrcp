/**
 * Capture pipeline: a parsed Obsidian note → a USRCP timeline event.
 *
 * Filters (applied in order; first match wins):
 *   1. excluded_subdirs (if rel path begins with any entry → skip)
 *   2. allowed_subdirs (if set, rel path must begin with one entry → otherwise skip)
 *   3. excluded_tags (any overlap with note tags → skip)
 *   4. allowed_tags (if set, must intersect with note tags → otherwise skip)
 *   5. empty body → skip
 *
 * Idempotency: `obsidian:<rel_path>:<sha256(content)[0..12]>`. Re-saving
 * the same content is a duplicate; an actual edit produces a new event.
 *
 * Single-user adapter: external_user_id is omitted.
 */

import { contentFingerprint, type ParsedNote } from "./parse.js";
import type { ObsidianConfig } from "./config.js";

export interface CaptureLedger {
  appendEvent(
    event: {
      domain: string;
      summary: string;
      intent: string;
      outcome: "success" | "partial" | "failed" | "abandoned";
      detail?: Record<string, unknown>;
      tags?: string[];
      channel_id?: string;
      thread_id?: string;
      external_user_id?: string;
    },
    platform: string,
    idempotencyKey?: string,
    agentId?: string
  ): { event_id: string; timestamp: string; ledger_sequence: number; duplicate?: boolean };
}

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason:
    | "excluded_subdir"
    | "subdir_not_allowlisted"
    | "excluded_tag"
    | "no_allowlisted_tag"
    | "empty_body";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

const SUMMARY_MAX_CHARS = 200;
// Cap how many of the note's tags we attach to the event tags array; full
// list still lives in detail.tags. Prevents one note with 50 inline #tags
// from polluting the event tag column.
const EVENT_TAG_LIMIT = 5;

/** Returns true iff `relPath` is under (or equal to) `prefix`. */
function pathStartsWith(relPath: string, prefix: string): boolean {
  if (prefix === "" || prefix === ".") return true;
  // Normalize: strip trailing slashes, treat as path segments.
  const norm = prefix.replace(/\/+$/, "");
  if (relPath === norm) return true;
  return relPath.startsWith(norm + "/");
}

export async function captureNote(
  ledger: CaptureLedger,
  note: ParsedNote,
  relPath: string,
  rawContent: string,
  config: ObsidianConfig,
): Promise<CaptureOutcome> {
  // 1. excluded_subdirs
  if (config.excluded_subdirs && config.excluded_subdirs.some((p) => pathStartsWith(relPath, p))) {
    return { captured: false, reason: "excluded_subdir" };
  }
  // 2. allowed_subdirs (if set)
  if (
    config.allowed_subdirs &&
    config.allowed_subdirs.length > 0 &&
    !config.allowed_subdirs.some((p) => pathStartsWith(relPath, p))
  ) {
    return { captured: false, reason: "subdir_not_allowlisted" };
  }
  // 3. excluded_tags
  if (config.excluded_tags && config.excluded_tags.length > 0) {
    const excluded = new Set(config.excluded_tags.map((t) => t.replace(/^#/, "")));
    if (note.tags.some((t) => excluded.has(t))) {
      return { captured: false, reason: "excluded_tag" };
    }
  }
  // 4. allowed_tags (if set)
  if (config.allowed_tags && config.allowed_tags.length > 0) {
    const allowed = new Set(config.allowed_tags.map((t) => t.replace(/^#/, "")));
    if (!note.tags.some((t) => allowed.has(t))) {
      return { captured: false, reason: "no_allowlisted_tag" };
    }
  }
  // 5. empty body
  if (!note.body || note.body.trim().length === 0) {
    return { captured: false, reason: "empty_body" };
  }

  const summary = note.title.length > SUMMARY_MAX_CHARS
    ? note.title.slice(0, SUMMARY_MAX_CHARS - 1) + "…"
    : note.title;

  const fp = await contentFingerprint(rawContent);
  const idempotencyKey = `obsidian:${relPath}:${fp}`;

  const eventTags = ["obsidian", "note", ...note.tags.slice(0, EVENT_TAG_LIMIT)];

  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "note_capture",
      outcome: "success",
      detail: {
        relative_path: relPath,
        title: note.title,
        body: note.body,
        frontmatter: note.frontmatterRaw,
        all_tags: note.tags,
        content_fingerprint: fp,
      },
      tags: eventTags,
      channel_id: relPath,
    },
    "obsidian",
    idempotencyKey,
    "obsidian-watcher",
  );

  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
