/**
 * Pure mapping from a Claude Code JSONL turn record to a usrcp-stream
 * CaptureEvent. No I/O, no side effects - the watcher owns the file
 * tail and dispatches each result here.
 *
 * Claude Code JSONL schema (verified on real session files, 2026-05-15):
 *
 *   type: "user" | "assistant"      -> turn records (the ones we want)
 *   type: "queue-operation"          -> internal command queue ops
 *   type: "attachment"               -> file/image attachments
 *   type: "ai-title"                 -> auto-generated session title
 *   type: "last-prompt"              -> bookkeeping pointer
 *
 * Each turn record carries:
 *   uuid, parentUuid, sessionId, timestamp (ISO), cwd, gitBranch?,
 *   isSidechain (boolean), version, message: { role, content, ... }
 *
 * Content can be either a string OR an array of blocks
 * ({ type: "text" | "tool_use" | "tool_result", ...}). We concatenate
 * `type: "text"` blocks and skip the rest in v0.1.
 */

const SURFACE = "claude-code";

export interface StreamCaptureEvent {
  surface: string;
  channel_ref: Record<string, unknown>;
  side: "inbound" | "outbound" | "system";
  author_ref: { id: string; displayName?: string };
  content: string;
  content_kind: "text";
  ts_ms: number;
  entity_refs?: string[];
}

export type MapResult =
  | { kind: "event"; event: StreamCaptureEvent }
  | { kind: "skip"; reason: SkipReason };

export type SkipReason =
  | "not_a_turn"           // type != user/assistant
  | "sidechain"            // sub-agent invocation
  | "missing_message"
  | "missing_role"
  | "missing_content"
  | "empty_text_content"   // content array had no text blocks
  | "missing_timestamp"
  | "missing_cwd";

interface RawTurn {
  type?: unknown;
  uuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  isSidechain?: unknown;
  message?: unknown;
}

interface MessageObj {
  role?: unknown;
  content?: unknown;
  id?: unknown;
  model?: unknown;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

export function mapTurnToStreamEvent(raw: unknown): MapResult {
  if (!raw || typeof raw !== "object") {
    return { kind: "skip", reason: "not_a_turn" };
  }
  const r = raw as RawTurn;
  if (r.type !== "user" && r.type !== "assistant") {
    return { kind: "skip", reason: "not_a_turn" };
  }
  if (r.isSidechain === true) {
    return { kind: "skip", reason: "sidechain" };
  }
  if (!r.message || typeof r.message !== "object") {
    return { kind: "skip", reason: "missing_message" };
  }
  const msg = r.message as MessageObj;
  if (msg.role !== "user" && msg.role !== "assistant") {
    return { kind: "skip", reason: "missing_role" };
  }
  if (typeof r.timestamp !== "string") {
    return { kind: "skip", reason: "missing_timestamp" };
  }
  if (typeof r.cwd !== "string" || r.cwd.length === 0) {
    return { kind: "skip", reason: "missing_cwd" };
  }
  const content = extractText(msg.content);
  if (content.length === 0) {
    return { kind: "skip", reason: typeof msg.content === "undefined" ? "missing_content" : "empty_text_content" };
  }

  const tsMs = Date.parse(r.timestamp);
  if (Number.isNaN(tsMs)) {
    return { kind: "skip", reason: "missing_timestamp" };
  }

  // Side mapping. role="user" means the human typed it (outbound from
  // the human's perspective); role="assistant" means Claude wrote it
  // (inbound from the human's perspective).
  const side: "inbound" | "outbound" =
    msg.role === "user" ? "outbound" : "inbound";

  // channel_ref keeps the cwd as the project identifier and the
  // sessionId for stitching turns inside the same Claude Code session.
  // gitBranch is included when present so the stitcher can disambiguate
  // a user juggling feature branches in the same repo.
  const channel_ref: Record<string, unknown> = {
    project: r.cwd,
  };
  if (typeof r.sessionId === "string") channel_ref.sessionId = r.sessionId;
  if (typeof r.gitBranch === "string" && r.gitBranch.length > 0) {
    channel_ref.gitBranch = r.gitBranch;
  }

  const displayName =
    msg.role === "assistant" && typeof msg.model === "string"
      ? `Claude (${msg.model})`
      : msg.role === "user"
        ? "user"
        : undefined;

  return {
    kind: "event",
    event: {
      surface: SURFACE,
      channel_ref,
      side,
      author_ref: {
        id: msg.role,
        displayName,
      },
      content,
      content_kind: "text",
      ts_ms: tsMs,
    },
  };
}
