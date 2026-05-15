import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStreamTools, type StreamRegistration } from "../register.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

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

type AnyServer = McpServer & {
  _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
};

async function callTool(server: McpServer, name: string, params: unknown) {
  const reg = (server as AnyServer)._registeredTools[name];
  if (!reg) throw new Error(`Tool '${name}' not registered`);
  return reg.handler(params);
}

function parseResponse(res: any): any {
  return JSON.parse(res.content[0].text);
}

let tmpDir: string;
let masterKey: Buffer;
let server: McpServer;
let registration: StreamRegistration;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-scope-"));
  masterKey = crypto.randomBytes(32);
});

afterEach(() => {
  registration?.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scope enforcement (Model A)", () => {
  it("allows stream_capture for an in-scope surface and rejects out-of-scope", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "agent-1" },
    });

    const allowed = parseResponse(await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "ok",
      content_kind: "text",
      ts_ms: Date.now(),
    }));
    expect(allowed.status).toBe("ok");

    const denied = parseResponse(await callTool(server, "stream_capture", {
      surface: "telegram",
      channel_ref: { chatId: 1 },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "blocked",
      content_kind: "text",
      ts_ms: Date.now(),
    }));
    expect(denied.status).toBe("out_of_scope");
    expect(denied.error).toBe("OUT_OF_SCOPE");
    expect(denied.tool).toBe("stream_capture");
    expect(denied.requested_domains).toEqual(["telegram"]);
    expect(denied.allowed_domains).toEqual(["discord"]);
  });

  it("multi-domain-read with explicit out-of-scope surface is rejected", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "agent-1" },
    });
    const res = parseResponse(await callTool(server, "stream_recall", {
      query: "anything",
      surface: "telegram",
    }));
    expect(res.status).toBe("out_of_scope");
  });

  it("multi-domain-read without surface filter passes (handler-level filtering)", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "agent-1" },
    });
    const res = parseResponse(await callTool(server, "stream_recall", {
      query: "anything",
    }));
    expect(res.status).toBe("ok");
  });

  it("global-read tools are always allowed regardless of scopes", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "agent-1" },
    });
    const status = parseResponse(await callTool(server, "stream_status", {}));
    expect(status.status).toBe("ok");
    const active = parseResponse(await callTool(server, "stream_active_surface", {}));
    expect(active.status).toBe("ok");
  });

  it("REGRESSION (Codex P0-1): scoped stream_recall without surface filter does not leak out-of-scope events", async () => {
    // Seed both surfaces from an UNSCOPED server so capture isn't blocked.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { g: "g1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "PUBLIC_DISCORD",
      content_kind: "text",
      ts_ms: 1000,
    });
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "c1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "SECRET_SCOPE_LEAK",
      content_kind: "text",
      ts_ms: 2000,
    });
    seedReg.shutdown();

    // Reopen with scope=discord and recall WITHOUT params.surface.
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(
      await callTool(server, "stream_recall", { query: "SECRET", limit: 50, min_score: -2 })
    );
    expect(res.status).toBe("ok");
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) {
      expect(h.surface).toBe("discord");
      expect(h.snippet_decrypted).not.toContain("SECRET_SCOPE_LEAK");
    }
  });

  it("REGRESSION (Codex P0-1): scoped stream_thread filters events to allowed surfaces", async () => {
    // Seed a thread that spans discord+telegram by sharing entity_refs.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    const cap1 = parseResponse(await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { g: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "discord event",
      content_kind: "text",
      ts_ms: 1000,
      entity_refs: ["p_x"],
    }));
    const cap2 = parseResponse(await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "SECRET_THREAD_LEAK",
      content_kind: "text",
      ts_ms: 1000 + 60 * 60 * 1000,
      entity_refs: ["p_x"],
    }));
    expect(cap2.thread_id).toBe(cap1.thread_id);
    seedReg.shutdown();

    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(
      await callTool(server, "stream_thread", { thread_id: cap1.thread_id })
    );
    expect(res.status).toBe("ok");
    // Only the discord event must be returned.
    expect(res.events).toHaveLength(1);
    expect(res.events[0].surface).toBe("discord");
    expect(res.events[0].content).not.toContain("SECRET_THREAD_LEAK");
    // The surfaces summary is narrowed to the intersection.
    expect(res.surfaces).toEqual(["discord"]);
  });

  it("readonly mode strips stream_capture from the registered tool list", () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readonly: true, agentId: "agent-1" },
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    expect(tools).not.toContain("stream_capture");
    expect(tools).toContain("stream_recall");
    expect(tools).toContain("stream_status");
  });
});
