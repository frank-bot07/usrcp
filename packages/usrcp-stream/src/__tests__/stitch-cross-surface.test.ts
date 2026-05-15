import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import { makeStitcher, type Stitcher, type StitchInput } from "../stitch/thread.js";
import { loadVectorExtension } from "../vector/index.js";

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;
let stitcher: Stitcher;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-stitch-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
  stitcher = makeStitcher(handle);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cross-surface stitching", () => {
  it("links events on different surfaces that share entity_refs into one thread", async () => {
    const baseTs = 1_700_000_000_000;
    const projectId = "p_solTrader";

    // Bridge ingest -> stitcher so events get a thread_id assigned at write.
    const stitchAdapter = (input: StitchInput) => stitcher.stitch(input);

    const e1 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "discord",
        channel_ref: { guild: "g1", channel: "c1" },
        side: "inbound",
        author_ref: { id: "u1", displayName: "Alice" },
        content: "fix the 429 in Sol-Trader",
        content_kind: "text",
        ts_ms: baseTs,
        entity_refs: [projectId],
      }
    );

    const e2 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "imessage",
        channel_ref: { chatId: "+15551234" },
        side: "inbound",
        author_ref: { id: "u1", displayName: "Alice" },
        content: "did you see my Sol-Trader retry?",
        content_kind: "text",
        ts_ms: baseTs + 2 * 60 * 60 * 1000, // 2h later
        entity_refs: [projectId],
      }
    );

    expect(e1.thread_id).not.toBeNull();
    expect(e2.thread_id).toBe(e1.thread_id);

    // Verify the thread row reflects both surfaces.
    const threadRow = handle.db
      .prepare("SELECT thread_id, member_count, surfaces FROM threads WHERE thread_id = ?")
      .get(e1.thread_id!) as { thread_id: string; member_count: number; surfaces: string };
    expect(threadRow.member_count).toBe(2);
    // We don't decrypt-assert surfaces here — already exercised in
    // encrypted-rows.test.ts. The member_count is the load-bearing check.
  });

  it("creates a new thread for unrelated events outside all windows", async () => {
    const baseTs = 1_700_000_000_000;
    const stitchAdapter = (input: StitchInput) => stitcher.stitch(input);

    const e1 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "discord",
        channel_ref: { guild: "g1", channel: "c1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "sol-trader stuff",
        content_kind: "text",
        ts_ms: baseTs,
        entity_refs: ["p_solTrader"],
      }
    );

    // 8h later, no shared entity, no embedding similarity, different channel.
    const e2 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "discord",
        channel_ref: { guild: "g2", channel: "c9" },
        side: "inbound",
        author_ref: { id: "u9" },
        content: "totally unrelated topic — banana bread recipe",
        content_kind: "text",
        ts_ms: baseTs + 8 * 60 * 60 * 1000,
        entity_refs: ["p_baking"],
      }
    );

    expect(e1.thread_id).not.toBeNull();
    expect(e2.thread_id).not.toBeNull();
    expect(e2.thread_id).not.toBe(e1.thread_id);

    const threadCount = handle.db.prepare("SELECT COUNT(*) as c FROM threads").get() as { c: number };
    expect(threadCount.c).toBe(2);
  });

  it("does NOT link across the entity window even with shared entity_refs", async () => {
    const baseTs = 1_700_000_000_000;
    const projectId = "p_solTrader";
    const stitchAdapter = (input: StitchInput) => stitcher.stitch(input);

    const e1 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "discord",
        channel_ref: { guild: "g1", channel: "c1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "x",
        content_kind: "text",
        ts_ms: baseTs,
        entity_refs: [projectId],
      }
    );

    // 30h later — outside both the 24h entity window and recency tau.
    const e2 = await captureEvent(
      { handle, embedder: null, stitch: stitchAdapter },
      {
        surface: "imessage",
        channel_ref: { chatId: "+1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "y",
        content_kind: "text",
        ts_ms: baseTs + 30 * 60 * 60 * 1000,
        entity_refs: [projectId],
      }
    );

    expect(e2.thread_id).not.toBe(e1.thread_id);
  });

  it("ingest leaves thread_id null when no stitch hook is provided", async () => {
    const ev = await captureEvent(
      { handle, embedder: null },
      {
        surface: "discord",
        channel_ref: { c: "x" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "no stitcher",
        content_kind: "text",
        ts_ms: Date.now(),
      }
    );
    expect(ev.thread_id).toBeNull();
  });
});
