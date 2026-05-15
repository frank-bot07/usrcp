import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import {
  makeStitcher,
  type Stitcher,
  type StitchInput,
} from "../stitch/thread.js";
import { loadVectorExtension } from "../vector/index.js";
import { DEFAULT_STITCH, type StitchConfig } from "../config.js";

// Codex P1-1: same (surface, channel_ref) within same_channel_window_ms
// must be load-bearing. These tests fail when same_channel_window_ms is
// shrunk below the configured gap.

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-same-ch-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function captureWith(stitcher: Stitcher) {
  const adapter = (input: StitchInput) => stitcher.stitch(input);
  return async (event: {
    surface: string;
    channel_ref: Record<string, unknown>;
    ts_ms: number;
    content: string;
    entity_refs?: string[];
  }) => {
    return captureEvent(
      { handle, embedder: null, stitch: adapter },
      {
        surface: event.surface,
        channel_ref: event.channel_ref,
        side: "inbound",
        author_ref: { id: "u1" },
        content: event.content,
        content_kind: "text",
        ts_ms: event.ts_ms,
        entity_refs: event.entity_refs,
      }
    );
  };
}

describe("same-channel continuation stitch", () => {
  it("links two events on the same (surface, channel_ref) within same_channel_window_ms", async () => {
    const stitcher = makeStitcher(handle); // default same_channel_window_ms = 30 min
    const capture = captureWith(stitcher);

    const base = 1_700_000_000_000;
    const e1 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base,
      content: "first",
    });
    // 25 min later, same channel, no entity_refs, no embedding.
    const e2 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base + 25 * 60 * 1000,
      content: "second",
    });
    expect(e2.thread_id).toBe(e1.thread_id);
  });

  it("does NOT link the same two events when same_channel_window_ms < gap", async () => {
    const tightConfig: StitchConfig = {
      ...DEFAULT_STITCH,
      same_channel_window_ms: 10 * 60 * 1000, // 10 min < 25 min gap
    };
    const stitcher = makeStitcher(handle, tightConfig);
    const capture = captureWith(stitcher);

    const base = 1_700_000_000_000;
    const e1 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base,
      content: "first",
    });
    const e2 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base + 25 * 60 * 1000,
      content: "second",
    });
    expect(e2.thread_id).not.toBe(e1.thread_id);
  });

  it("does NOT link two events when channel_ref differs even within the window", async () => {
    const stitcher = makeStitcher(handle);
    const capture = captureWith(stitcher);

    const base = 1_700_000_000_000;
    const e1 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base,
      content: "first",
    });
    const e2 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c2" }, // different channel
      ts_ms: base + 5 * 60 * 1000,
      content: "second",
    });
    expect(e2.thread_id).not.toBe(e1.thread_id);
  });

  it("channel_ref key ordering does not affect match (canonical form)", async () => {
    const stitcher = makeStitcher(handle);
    const capture = captureWith(stitcher);

    const base = 1_700_000_000_000;
    const e1 = await capture({
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      ts_ms: base,
      content: "first",
    });
    const e2 = await capture({
      surface: "discord",
      channel_ref: { channel: "c1", guild: "g1" }, // same fields, different insertion order
      ts_ms: base + 5 * 60 * 1000,
      content: "second",
    });
    expect(e2.thread_id).toBe(e1.thread_id);
  });
});
