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

  it("REGRESSION (Codex round-2 P0-1): scoped stream_thread on a wholly out-of-scope thread returns not_found with no metadata", async () => {
    // Seed a telegram-only thread whose entity_refs would be sensitive.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    const c1 = parseResponse(
      await callTool(seed, "stream_capture", {
        surface: "telegram",
        channel_ref: { c: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "first",
        content_kind: "text",
        ts_ms: 1000,
        entity_refs: ["SECRET_PROJECT_ID"],
      })
    );
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "second",
      content_kind: "text",
      ts_ms: 1000 + 5 * 60 * 1000,
      entity_refs: ["SECRET_PROJECT_ID"],
    });
    seedReg.shutdown();

    // Discord-scoped server fetches the thread.
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(
      await callTool(server, "stream_thread", { thread_id: c1.thread_id })
    );
    // Must NOT expose any thread-level metadata when no events are in-scope.
    expect(res.status).toBe("not_found");
    expect(res.events).toEqual([]);
    expect(res.entity_refs).toBeUndefined();
    expect(res.surfaces).toBeUndefined();
    expect(res.first_ts_ms).toBeUndefined();
    expect(res.last_ts_ms).toBeUndefined();
    // Sanity: the full JSON body does not contain the leaked entity name anywhere.
    expect(JSON.stringify(res)).not.toContain("SECRET_PROJECT_ID");
  });

  it("REGRESSION (Codex round-2 P0-1): mixed-scope thread returns only in-scope events AND derives metadata from them", async () => {
    // Thread that spans discord (in scope) + telegram (out of scope) with
    // entity_refs only present on the telegram events. The response from
    // a discord-scoped server should NOT expose the telegram-side
    // entity_refs as thread metadata.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    const c1 = parseResponse(
      await callTool(seed, "stream_capture", {
        surface: "discord",
        channel_ref: { g: "1" },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "public discord event",
        content_kind: "text",
        ts_ms: 1000,
        entity_refs: ["p_shared"],
      })
    );
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "telegram event with SECRETIVE_ENTITY",
      content_kind: "text",
      ts_ms: 1000 + 60 * 60 * 1000,
      entity_refs: ["p_shared", "SECRETIVE_ENTITY"],
    });
    seedReg.shutdown();

    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { scopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(
      await callTool(server, "stream_thread", { thread_id: c1.thread_id })
    );
    expect(res.status).toBe("ok");
    expect(res.events).toHaveLength(1);
    expect(res.events[0].surface).toBe("discord");
    expect(res.surfaces).toEqual(["discord"]);
    // entity_refs are derived from the in-scope event only, so SECRETIVE_ENTITY
    // (which only appears on the telegram event) MUST NOT be returned.
    expect(res.entity_refs).toEqual(["p_shared"]);
    expect(JSON.stringify(res)).not.toContain("SECRETIVE_ENTITY");
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

// ---------------------------------------------------------------------------
// Asymmetric scopes (PR #61): readScopes + writeScopes propagate to stream
// tools the same way they do for usrcp-local. Without this, the stream
// register would have only enforced legacy `scopes`/`readonly` and bypassed
// the new flags entirely. Codex round-1 review on PR #61 caught this.
// ---------------------------------------------------------------------------

describe("asymmetric scopes (PR #61 round-1 fix)", () => {
  it("--read-scopes alone strips mutating stream tools from tools/list", () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readScopes: ["discord"], agentId: "a1" },
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    // Mutating tools stripped because writeScopes defaults to [].
    expect(tools).not.toContain("stream_capture");
    // Read tools still registered.
    expect(tools).toContain("stream_recall");
    expect(tools).toContain("stream_thread");
    expect(tools).toContain("stream_active_surface");
    expect(tools).toContain("stream_status");
  });

  it("--read-scopes constrains stream_recall to the listed surfaces", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readScopes: ["discord"], agentId: "a1" },
    });
    const denied = parseResponse(await callTool(server, "stream_recall", {
      query: "anything",
      surface: "telegram",
    }));
    expect(denied.status).toBe("out_of_scope");
  });

  it("--write-scopes alone allows stream_capture only on the listed surfaces", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { writeScopes: ["discord"], agentId: "a1" },
    });
    const ok = parseResponse(await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "allowed",
      content_kind: "text",
      ts_ms: Date.now(),
    }));
    expect(ok.status).toBe("ok");

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
  });

  it("--write-scopes alone leaves stream_recall unrestricted (reads any surface)", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { writeScopes: ["discord"], agentId: "a1" },
    });
    // Recall on a surface the writer doesn't have write access to
    // should still work because reads are unrestricted.
    const recall = parseResponse(await callTool(server, "stream_recall", {
      query: "x",
      surface: "telegram",
    }));
    // Either an empty hits array (no data) or a non-out_of_scope status.
    expect(recall.status).not.toBe("out_of_scope");
  });

  it("read+write asymmetric subset enforces both ways on stream tools", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: {
        readScopes: ["discord", "telegram"],
        writeScopes: ["discord"],
        agentId: "a1",
      },
    });
    // Read on either allowlisted surface works.
    const recallOk = parseResponse(await callTool(server, "stream_recall", {
      query: "x",
      surface: "telegram",
    }));
    expect(recallOk.status).not.toBe("out_of_scope");

    // Write to telegram (in readScopes but NOT writeScopes) - rejected.
    const writeBad = parseResponse(await callTool(server, "stream_capture", {
      surface: "telegram",
      channel_ref: { chatId: 1 },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "blocked",
      content_kind: "text",
      ts_ms: Date.now(),
    }));
    expect(writeBad.status).toBe("out_of_scope");

    // Write to discord (in both) - accepted.
    const writeOk = parseResponse(await callTool(server, "stream_capture", {
      surface: "discord",
      channel_ref: { c: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "allowed",
      content_kind: "text",
      ts_ms: Date.now(),
    }));
    expect(writeOk.status).toBe("ok");
  });

  it("rejects --scopes combined with --read-scopes at register time", () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    expect(() =>
      registerStreamTools(server, {
        masterKey,
        userDir: tmpDir,
        embedder: new FakeEmbedder(),
        serveOptions: {
          scopes: ["discord"],
          readScopes: ["discord"],
          agentId: "a1",
        },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects writeScopes containing a domain not in readScopes", () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    expect(() =>
      registerStreamTools(server, {
        masterKey,
        userDir: tmpDir,
        embedder: new FakeEmbedder(),
        serveOptions: {
          readScopes: ["discord"],
          writeScopes: ["telegram"], // not in readScopes
          agentId: "a1",
        },
      }),
    ).toThrow(/not in readScopes/);
  });
});

// ---------------------------------------------------------------------------
// Regression: createStreamServer (standalone path) must forward the
// new readScopes/writeScopes fields to registerStreamTools. The first
// cut of PR #61 fixed the unified usrcp serve path but the standalone
// `usrcp-stream` entry-point rebuilt serveOptions with only the
// pre-asymmetric fields, silently dropping readScopes/writeScopes.
// Codex round-2 review on PR #61 caught this.
// ---------------------------------------------------------------------------

import { setUserSlug } from "usrcp-local/dist/encryption.js";
import { createStreamServer } from "../server.js";

describe("createStreamServer forwards asymmetric scopes (PR #61 round-2 fix)", () => {
  let origHome: string | undefined;
  let standaloneTmpHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    standaloneTmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "usrcp-stream-standalone-"),
    );
    process.env.HOME = standaloneTmpHome;
    setUserSlug("default");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    setUserSlug("default");
    fs.rmSync(standaloneTmpHome, { recursive: true, force: true });
  });

  it("readScopes is forwarded - mutating tools stripped on the standalone server", () => {
    const { server: standalone, shutdown } = createStreamServer(undefined, {
      readScopes: ["discord"],
      agentId: "standalone-test",
    });
    try {
      const tools = Object.keys((standalone as AnyServer)._registeredTools);
      // Mutating tools stripped because writeScopes defaults to [] when
      // only readScopes is set. Without the fix, readScopes was dropped
      // by server.ts's rebuild, so writes would have stayed open.
      expect(tools).not.toContain("stream_capture");
      expect(tools).toContain("stream_recall");
      expect(tools).toContain("stream_status");
    } finally {
      shutdown();
    }
  });

  it("writeScopes is forwarded - constrains stream_capture on the standalone server", async () => {
    const { server: standalone, shutdown } = createStreamServer(undefined, {
      writeScopes: ["discord"],
      agentId: "standalone-test",
    });
    try {
      const denied = parseResponse(await callTool(standalone, "stream_capture", {
        surface: "telegram",
        channel_ref: { chatId: 1 },
        side: "inbound",
        author_ref: { id: "u1" },
        content: "should be rejected on standalone server",
        content_kind: "text",
        ts_ms: Date.now(),
      }));
      expect(denied.status).toBe("out_of_scope");
    } finally {
      shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: stream_prewarm cross-surface read must honor the read
// allowlist. codex PR #61 round-4 caught this end-to-end leak.
// ---------------------------------------------------------------------------

describe("stream_prewarm respects readScopes (PR #61 round-4 fix)", () => {
  it("a read-scoped agent calling prewarm gets only in-scope cross-surface content", async () => {
    // Seed events across three surfaces from an unscoped server.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    await callTool(seed, "stream_capture", {
      surface: "cursor",
      channel_ref: { w: "/p" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "PUBLIC_CURSOR_CONTENT",
      content_kind: "text",
      ts_ms: Date.now() - 60_000,
    });
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "x" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "SECRET_TELEGRAM_LEAK",
      content_kind: "text",
      ts_ms: Date.now() - 30_000,
    });
    await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { guild: "g", channel: "c" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "discord active",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    seedReg.shutdown();

    // Read scope = cursor + discord (NOT telegram).
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: {
        readScopes: ["cursor", "discord"],
        writeScopes: [],   // explicitly forbid writes so the existing
                           // allowlist gate doesn't strip prewarm too.
        agentId: "a1",
      },
    });

    const res = parseResponse(await callTool(server, "stream_prewarm", {
      target_surface: "discord",
      window_min: 60,
    }));
    expect(res.status).toBe("ok");
    expect(res.summary).toContain("PUBLIC_CURSOR_CONTENT");
    // CRITICAL: telegram content must NOT appear in the handoff.
    expect(res.summary).not.toContain("SECRET_TELEGRAM_LEAK");
    expect(res.source_surfaces).toEqual(["cursor"]);
  });
});

// ---------------------------------------------------------------------------
// Codex PR #61 round-5: global-read tools (stream_active_surface,
// stream_status) previously fell through scope checks entirely. A
// read-scoped agent could learn the most-recent surface name and
// ledger-wide counts even when those reference out-of-scope surfaces.
// ---------------------------------------------------------------------------

describe("global-read tools respect readScopes (PR #61 round-5 fix)", () => {
  it("stream_active_surface returns null when the most-recent surface is out of read scope", async () => {
    // Seed events on telegram (newest) and discord (older).
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { g: "g1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "older",
      content_kind: "text",
      ts_ms: Date.now() - 60_000,
    });
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "c1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "newer",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    seedReg.shutdown();

    // Read scope = discord only. Most-recent activity is telegram.
    // The active-surface tool MUST NOT leak that telegram is most-active.
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readScopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(await callTool(server, "stream_active_surface", {}));
    expect(res.status).toBe("ok");
    // The discord activity is within the window (60s old), so the
    // tool returns the most-recent IN-SCOPE surface.
    expect(res.active).not.toBeNull();
    expect(res.active.surface).toBe("discord");
  });

  it("stream_active_surface returns null when there's no in-scope activity at all", async () => {
    // Seed only out-of-scope events.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "c1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "out of scope",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    seedReg.shutdown();

    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readScopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(await callTool(server, "stream_active_surface", {}));
    expect(res.status).toBe("ok");
    expect(res.active).toBeNull();
  });

  it("stream_status returns scope-filtered counts and omits db_path when readScopes is restrictive", async () => {
    // Seed three events: 2 in discord, 1 in telegram.
    const seed = new McpServer({ name: "seed", version: "0" });
    const seedReg = registerStreamTools(seed, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { g: "g1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "d1",
      content_kind: "text",
      ts_ms: Date.now() - 60_000,
    });
    await callTool(seed, "stream_capture", {
      surface: "discord",
      channel_ref: { g: "g1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "d2",
      content_kind: "text",
      ts_ms: Date.now() - 30_000,
    });
    await callTool(seed, "stream_capture", {
      surface: "telegram",
      channel_ref: { c: "c1" },
      side: "outbound",
      author_ref: { id: "u1" },
      content: "t1",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    seedReg.shutdown();

    // Read scope = discord. Status MUST show 2 events, not 3, and
    // MUST NOT include db_path.
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
      serveOptions: { readScopes: ["discord"], agentId: "a1" },
    });
    const res = parseResponse(await callTool(server, "stream_status", {}));
    expect(res.status).toBe("ok");
    expect(res.scoped).toBe(true);
    expect(res.allowed_surfaces).toEqual(["discord"]);
    expect(res.event_count).toBe(2);
    expect(res.surface_count).toBe(1);
    expect(res.db_path).toBeUndefined();
  });

  it("stream_status without scopes returns ledger-wide totals AND db_path (no regression)", async () => {
    server = new McpServer({ name: "t", version: "0.0.0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: new FakeEmbedder(),
    });
    const res = parseResponse(await callTool(server, "stream_status", {}));
    expect(res.status).toBe("ok");
    expect(res.scoped).toBeUndefined();
    expect(res.db_path).toBeTruthy();
  });
});
