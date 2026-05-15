import { describe, it, expect } from "vitest";
import { mapTurnToStreamEvent } from "../capture.js";

describe("mapTurnToStreamEvent", () => {
  it("maps a type=user record to outbound", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      uuid: "u-1",
      sessionId: "s-1",
      timestamp: "2026-05-15T17:00:00.000Z",
      cwd: "/Users/frankbot/usrcp",
      isSidechain: false,
      message: { role: "user", content: "hello from the user" },
    });
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.surface).toBe("claude-code");
    expect(r.event.side).toBe("outbound");
    expect(r.event.content).toBe("hello from the user");
    expect(r.event.channel_ref).toMatchObject({ project: "/Users/frankbot/usrcp", sessionId: "s-1" });
    expect(r.event.author_ref).toEqual({ id: "user", displayName: "user" });
    expect(r.event.ts_ms).toBe(Date.parse("2026-05-15T17:00:00.000Z"));
    expect(r.event.content_kind).toBe("text");
  });

  it("maps a type=assistant record with string content to inbound", () => {
    const r = mapTurnToStreamEvent({
      type: "assistant",
      uuid: "u-2",
      sessionId: "s-1",
      timestamp: "2026-05-15T17:00:30.000Z",
      cwd: "/Users/frankbot/usrcp",
      isSidechain: false,
      message: { role: "assistant", content: "and back from Claude", model: "claude-opus-4-7" },
    });
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.side).toBe("inbound");
    expect(r.event.content).toBe("and back from Claude");
    expect(r.event.author_ref.displayName).toBe("Claude (claude-opus-4-7)");
  });

  it("concatenates text blocks and skips tool_use/tool_result from array content", () => {
    const r = mapTurnToStreamEvent({
      type: "assistant",
      uuid: "u-3",
      sessionId: "s-1",
      timestamp: "2026-05-15T17:00:45.000Z",
      cwd: "/Users/frankbot/usrcp",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } },
          { type: "text", text: "Here's what I found." },
          { type: "tool_result", tool_use_id: "tu-1", content: "..." },
        ],
        model: "claude-opus-4-7",
      },
    });
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.content).toBe("Let me check that file.\nHere's what I found.");
  });

  it("includes gitBranch in channel_ref when present", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      uuid: "u-4",
      sessionId: "s-1",
      timestamp: "2026-05-15T17:01:00.000Z",
      cwd: "/Users/frankbot/usrcp",
      gitBranch: "feat/usrcp-claude-code",
      isSidechain: false,
      message: { role: "user", content: "x" },
    });
    expect(r.kind).toBe("event");
    if (r.kind !== "event") return;
    expect(r.event.channel_ref).toMatchObject({ gitBranch: "feat/usrcp-claude-code" });
  });

  it("skips records with isSidechain=true", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      uuid: "u-5",
      sessionId: "s-1",
      timestamp: "2026-05-15T17:01:30.000Z",
      cwd: "/Users/frankbot/usrcp",
      isSidechain: true,
      message: { role: "user", content: "sub-agent prompt" },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("sidechain");
  });

  it.each([
    ["queue-operation", { type: "queue-operation", operation: "enqueue", sessionId: "s", timestamp: "2026-05-15T17:00:00Z", content: "..." }],
    ["attachment", { type: "attachment", sessionId: "s", timestamp: "2026-05-15T17:00:00Z" }],
    ["ai-title", { type: "ai-title", sessionId: "s", aiTitle: "title" }],
    ["last-prompt", { type: "last-prompt", sessionId: "s", lastPrompt: "x" }],
  ])("skips non-turn record type=%s", (_label, line) => {
    const r = mapTurnToStreamEvent(line);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("not_a_turn");
  });

  it("skips when message field is absent", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      cwd: "/x",
      timestamp: "2026-05-15T17:00:00Z",
      isSidechain: false,
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("missing_message");
  });

  it("skips when message.role is malformed", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      cwd: "/x",
      timestamp: "2026-05-15T17:00:00Z",
      isSidechain: false,
      message: { content: "x" },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("missing_role");
  });

  it("skips when content array has no text blocks", () => {
    const r = mapTurnToStreamEvent({
      type: "assistant",
      cwd: "/x",
      timestamp: "2026-05-15T17:00:00Z",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_result", tool_use_id: "x", content: "..." },
        ],
        model: "claude-opus-4-7",
      },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("empty_text_content");
  });

  it("skips when content is missing entirely", () => {
    const r = mapTurnToStreamEvent({
      type: "assistant",
      cwd: "/x",
      timestamp: "2026-05-15T17:00:00Z",
      isSidechain: false,
      message: { role: "assistant" },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("missing_content");
  });

  it("skips when timestamp is malformed", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      cwd: "/x",
      timestamp: "not-a-date",
      isSidechain: false,
      message: { role: "user", content: "x" },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("missing_timestamp");
  });

  it("skips when cwd is missing", () => {
    const r = mapTurnToStreamEvent({
      type: "user",
      timestamp: "2026-05-15T17:00:00Z",
      isSidechain: false,
      message: { role: "user", content: "x" },
    });
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("missing_cwd");
  });

  it("non-object input is skipped as not_a_turn", () => {
    expect(mapTurnToStreamEvent(null).kind).toBe("skip");
    expect(mapTurnToStreamEvent("just a string").kind).toBe("skip");
    expect(mapTurnToStreamEvent(42).kind).toBe("skip");
  });
});
