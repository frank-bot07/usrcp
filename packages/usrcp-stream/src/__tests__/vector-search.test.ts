import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { openStreamDb, closeStreamDb, type StreamHandle } from "../db/index.js";
import { captureEvent } from "../capture/ingest.js";
import { loadVectorExtension } from "../vector/index.js";
import { vectorSearch } from "../vector/search.js";
import { OllamaEmbedder, pingOllama } from "../embeddings/ollama.js";

// Ollama-gated. Tests skip if the local daemon isn't reachable so the
// suite stays green on a fresh checkout without forcing every contributor
// to install Ollama. CI either provides Ollama or these tests no-op.

let ollamaUp = false;

beforeAll(async () => {
  ollamaUp = await pingOllama();
});

let handle: StreamHandle;
let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-vec-"));
  masterKey = crypto.randomBytes(32);
  handle = openStreamDb(tmpDir, masterKey);
  loadVectorExtension(handle.db);
});

afterEach(() => {
  closeStreamDb(handle);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("vector-search", () => {
  it("loads the sqlite-vec extension cleanly", () => {
    const row = handle.db.prepare("SELECT vec_version() as version").get() as { version: string };
    expect(typeof row.version).toBe("string");
    expect(row.version.length).toBeGreaterThan(0);
  });

  it("ranks semantically similar events above unrelated ones", async (ctx) => {
    if (!ollamaUp) {
      ctx.skip();
      return;
    }
    const embedder = new OllamaEmbedder();

    // 9 events: 3 about React performance, 3 about Postgres indexing,
    // 3 about pet care. The query is a paraphrase of one cluster — the
    // top-3 hits should be that cluster.
    const reactCluster = [
      "React rerenders are killing my list view performance",
      "How do I memoize this component to stop unnecessary renders",
      "useCallback vs useMemo for stopping child re-renders",
    ];
    const postgresCluster = [
      "Postgres B-tree index isn't being used by my query planner",
      "Should I add a partial index for the soft-deleted rows",
      "EXPLAIN ANALYZE shows a sequential scan despite the index",
    ];
    const petCluster = [
      "My cat keeps knocking things off the counter",
      "Best chew toys for a teething puppy",
      "How often should I clip a rabbit's nails",
    ];

    let ts = Date.now();
    for (const cluster of [reactCluster, postgresCluster, petCluster]) {
      for (const content of cluster) {
        await captureEvent(
          { handle, embedder },
          {
            surface: "discord",
            channel_ref: { c: "x" },
            side: "inbound",
            author_ref: { id: "u1" },
            content,
            content_kind: "text",
            ts_ms: ts++,
          }
        );
      }
    }

    const queryVec = await embedder.embed("component is rerendering too many times in React");
    const normalized = (await import("../embeddings/provider.js")).normalize(queryVec);

    const hits = vectorSearch(handle, normalized, { dims: embedder.dims, limit: 3 });
    expect(hits).toHaveLength(3);

    const topContents = hits.map((h) => h.snippet_decrypted);
    const reactHits = topContents.filter((c) => reactCluster.includes(c)).length;
    expect(reactHits).toBe(3);

    // Scores descend monotonically (closest match first).
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[1].score).toBeGreaterThanOrEqual(hits[2].score);
  }, 60_000);

  it("respects the surface filter", async (ctx) => {
    if (!ollamaUp) {
      ctx.skip();
      return;
    }
    const embedder = new OllamaEmbedder();

    const ts = Date.now();
    await captureEvent({ handle, embedder }, {
      surface: "discord",
      channel_ref: { c: "x" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "kubernetes cluster autoscaling",
      content_kind: "text",
      ts_ms: ts,
    });
    await captureEvent({ handle, embedder }, {
      surface: "telegram",
      channel_ref: { chatId: 1 },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "kubernetes cluster autoscaling",
      content_kind: "text",
      ts_ms: ts + 1,
    });

    const queryVec = await embedder.embed("kubernetes autoscaling");
    const normalized = (await import("../embeddings/provider.js")).normalize(queryVec);

    const onlyDiscord = vectorSearch(handle, normalized, { dims: embedder.dims, surface: "discord", limit: 10 });
    expect(onlyDiscord.every((h) => h.surface === "discord")).toBe(true);
    expect(onlyDiscord).toHaveLength(1);
  }, 60_000);
});
