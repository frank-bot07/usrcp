import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import { getActiveSurface } from "../surface/presence.js";
import { prewarm } from "../surface/prewarm.js";
import { loadVectorExtension } from "../vector/index.js";

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-prewarm-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("active-surface presence", () => {
  it("returns null when no surface has recent activity", () => {
    expect(getActiveSurface(handle)).toBeNull();
  });

  it("returns the most recently active surface within the window", async () => {
    const now = Date.now();
    await captureEvent(
      { handle, embedder: null },
      {
        surface: "cursor",
        channel_ref: { workspace: "/Users/me/foo" },
        side: "outbound",
        author_ref: { id: "u1" },
        content: "typing in cursor",
        content_kind: "text",
        ts_ms: now - 60 * 1000,
      }
    );
    await captureEvent(
      { handle, embedder: null },
      {
        surface: "discord",
        channel_ref: { guild: "g1", channel: "c1" },
        side: "inbound",
        author_ref: { id: "u2" },
        content: "discord message",
        content_kind: "text",
        ts_ms: now,
      }
    );

    const active = getActiveSurface(handle, undefined, now);
    expect(active).not.toBeNull();
    expect(active!.surface).toBe("discord");
  });

  it("excludes surfaces that fell outside the active window", async () => {
    const now = Date.now();
    await captureEvent(
      { handle, embedder: null },
      {
        surface: "cursor",
        channel_ref: { workspace: "/foo" },
        side: "outbound",
        author_ref: { id: "u1" },
        content: "old activity",
        content_kind: "text",
        ts_ms: now - 60 * 60 * 1000, // 60 min ago — outside default 10-min window
      }
    );

    const active = getActiveSurface(handle, undefined, now);
    expect(active).toBeNull();
  });
});

describe("pre-warm", () => {
  it("builds a summary that contains content from the prior surface", async () => {
    const now = Date.now();

    // 5 events on Cursor over 5 minutes
    for (let i = 0; i < 5; i++) {
      await captureEvent(
        { handle, embedder: null },
        {
          surface: "cursor",
          channel_ref: { workspace: "/Users/me/proj" },
          side: "outbound",
          author_ref: { id: "u1" },
          content: `editing src/server.ts: fixed retry on 429 (snippet ${i})`,
          content_kind: "text",
          ts_ms: now - (5 - i) * 60 * 1000,
        }
      );
    }

    // 1 event on Discord that switches active surface
    await captureEvent(
      { handle, embedder: null },
      {
        surface: "discord",
        channel_ref: { guild: "g1", channel: "c1" },
        side: "outbound",
        author_ref: { id: "u1" },
        content: "switching to discord now",
        content_kind: "text",
        ts_ms: now,
      }
    );

    const active = getActiveSurface(handle, undefined, now);
    expect(active!.surface).toBe("discord");

    const result = await prewarm(
      handle,
      { target_surface: "discord", window_min: 30, now }
    );

    expect(result.events_count).toBe(5);
    expect(result.source_surfaces).toEqual(["cursor"]);
    expect(result.summary).toContain("cursor");
    expect(result.summary).toContain("retry on 429");
    expect(result.decay_ms).toBeGreaterThan(0);
  });

  it("returns the empty-state summary when there is no recent activity on any other surface", async () => {
    const result = await prewarm(
      handle,
      { target_surface: "discord", window_min: 30 }
    );
    expect(result.events_count).toBe(0);
    expect(result.source_surfaces).toEqual([]);
    expect(result.summary).toContain("no recent activity");
  });

  it("uses the injected summarizer when provided and falls back if it throws", async () => {
    const now = Date.now();
    await captureEvent(
      { handle, embedder: null },
      {
        surface: "cursor",
        channel_ref: { w: "x" },
        side: "outbound",
        author_ref: { id: "u1" },
        content: "the answer is forty-two",
        content_kind: "text",
        ts_ms: now - 60 * 1000,
      }
    );

    const ok = await prewarm(
      handle,
      {
        target_surface: "discord",
        window_min: 30,
        now,
        summarizer: async (events) => `SUMMARY[${events.length}]: ${events[0].content}`,
      }
    );
    expect(ok.summary).toBe("SUMMARY[1]: the answer is forty-two");

    const fallback = await prewarm(
      handle,
      {
        target_surface: "discord",
        window_min: 30,
        now,
        summarizer: async () => {
          throw new Error("api dead");
        },
      }
    );
    expect(fallback.summary).toContain("the answer is forty-two");
  });
});
