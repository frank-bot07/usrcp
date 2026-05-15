import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStreamTools, type StreamRegistration } from "../register.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// Deterministic in-process embedder so the suite stays Ollama-independent.
class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake-deterministic";
  async embed(text: string): Promise<Float32Array> {
    const seed = crypto.createHash("sha256").update(text).digest();
    const vec = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      vec[i] = (seed[i % seed.length] / 255) * 2 - 1;
    }
    return vec;
  }
}

// Internal harness: pull the registered tool's handler off the McpServer
// instance. The SDK exposes registered tools via _registeredTools (an
// implementation detail) — calling it directly avoids spinning up a
// stdio transport for unit tests.
type AnyServer = McpServer & {
  _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
};

async function callTool(server: McpServer, name: string, params: unknown) {
  const reg = (server as AnyServer)._registeredTools[name];
  if (!reg) throw new Error(`Tool '${name}' not registered`);
  return reg.handler(params);
}

function parseResponse(res: any): any {
  const text = res.content[0].text;
  return JSON.parse(text);
}

let tmpDir: string;
let masterKey: Buffer;
let server: McpServer;
let registration: StreamRegistration;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-mcp-"));
  masterKey = crypto.randomBytes(32);
  server = new McpServer({ name: "test-stream", version: "0.0.0" });
  registration = registerStreamTools(server, {
    masterKey,
    userDir: tmpDir,
    embedder: new FakeEmbedder(),
  });
});

afterEach(() => {
  registration.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp-tools — surface shape", () => {
  it("registers all six stream_* tools", () => {
    const tools = Object.keys((server as AnyServer)._registeredTools);
    const streamTools = tools.filter((t) => t.startsWith("stream_"));
    expect(streamTools.sort()).toEqual([
      "stream_active_surface",
      "stream_capture",
      "stream_prewarm",
      "stream_recall",
      "stream_status",
      "stream_thread",
    ]);
  });

  it("stream_capture returns event_uuid, thread_id, ingested_at", async () => {
    const res = await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      side: "inbound",
      author_ref: { id: "u1", displayName: "Alice" },
      content: "hello",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const body = parseResponse(res);
    expect(body.status).toBe("ok");
    expect(body.event_uuid).toBeTruthy();
    expect(body.thread_id).toBeTruthy();
    expect(body.ingested_at).toBeGreaterThan(0);
  });

  it("stream_status reports the expected fields", async () => {
    await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "x",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const body = parseResponse(await callTool(server, "stream_status", {}));
    expect(body.status).toBe("ok");
    expect(body.event_count).toBe(1);
    expect(body.surface_count).toBe(1);
    expect(body.embedding_model).toBe("fake-deterministic");
    expect(body.vector_backend).toBe("sqlite-vec");
    expect(body.db_path).toContain("stream.db");
  });

  it("stream_active_surface returns null then the latest surface", async () => {
    const empty = parseResponse(await callTool(server, "stream_active_surface", {}));
    expect(empty.active).toBeNull();

    await callTool(server, "stream_capture", {
      surface: "cursor",
      channel_ref: { w: "x" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "active",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const after = parseResponse(await callTool(server, "stream_active_surface", {}));
    expect(after.active).not.toBeNull();
    expect(after.active.surface).toBe("cursor");
  });

  it("stream_thread returns events grouped by thread_id", async () => {
    const cap1 = parseResponse(await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { guild: "g1", channel: "c1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "first",
      content_kind: "text",
      ts_ms: 1000,
      entity_refs: ["p_x"],
    }));
    const cap2 = parseResponse(await callTool(server, "stream_capture", {
      surface: "imessage",
      channel_ref: { chatId: "+1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "second",
      content_kind: "text",
      ts_ms: 1000 + 60 * 60 * 1000,
      entity_refs: ["p_x"],
    }));
    expect(cap2.thread_id).toBe(cap1.thread_id);

    const thread = parseResponse(await callTool(server, "stream_thread", {
      thread_id: cap1.thread_id,
    }));
    expect(thread.status).toBe("ok");
    expect(thread.events).toHaveLength(2);
    expect(thread.surfaces.sort()).toEqual(["discord", "imessage"]);
    expect(thread.events[0].content).toBe("first");
    expect(thread.events[1].content).toBe("second");
  });

  it("stream_recall returns hits with score and decrypted snippet", async () => {
    for (const content of ["alpha topic", "beta topic", "gamma topic"]) {
      await callTool(server, "stream_capture", {
        surface: "discord",
        channel_ref: { g: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content,
        content_kind: "text",
        ts_ms: Date.now(),
      });
    }
    const res = parseResponse(await callTool(server, "stream_recall", {
      query: "alpha topic",
      limit: 3,
    }));
    expect(res.status).toBe("ok");
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) {
      expect(h.snippet_decrypted).toBeTruthy();
      expect(typeof h.score).toBe("number");
    }
  });

  it("stream_prewarm summarizes cross-surface activity", async () => {
    const now = Date.now();
    await callTool(server, "stream_capture", {
      surface: "cursor",
      channel_ref: { w: "/proj" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "fixed the auth token refresh bug",
      content_kind: "text",
      ts_ms: now - 60 * 1000,
    });
    const res = parseResponse(await callTool(server, "stream_prewarm", {
      target_surface: "discord",
      window_min: 30,
    }));
    expect(res.status).toBe("ok");
    expect(res.events_count).toBe(1);
    expect(res.source_surfaces).toEqual(["cursor"]);
    expect(res.summary).toContain("auth token");
  });
});
