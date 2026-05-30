import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ledger } from "usrcp-local/ledger";
import { setUserSlug } from "usrcp-local/encryption";
import { registerStreamTools, type StreamRegistration } from "../register.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

class FakeEmbedder implements EmbeddingProvider {
  readonly dims = 64;
  readonly model = "fake";
  async embed(text: string): Promise<Float32Array> {
    const h = crypto.createHash("sha256").update(text).digest();
    const v = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) v[i] = (h[i % h.length] / 255) * 2 - 1;
    return v;
  }
}

type AnyServer = McpServer & {
  _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }>;
};

async function callTool(server: McpServer, name: string, params: unknown) {
  const reg = (server as AnyServer)._registeredTools[name];
  if (!reg) throw new Error(`Tool '${name}' not registered`);
  return reg.handler(params);
}

function parseResponse(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let server: McpServer;
let registration: StreamRegistration;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-mcp-sync-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  ledger = new Ledger(path.join(tmpHome, "ledger.db"));
});

afterEach(() => {
  try { registration?.shutdown(); } catch { /* */ }
  try { ledger.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("MCP sync tools registration", () => {
  it("does NOT register sync tools when cloudEndpoint is omitted", () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      ledger,
      embedder: new FakeEmbedder(),
      // cloudEndpoint omitted
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    expect(tools).not.toContain("stream_sync_push");
    expect(tools).not.toContain("stream_sync_pull");
    expect(tools).not.toContain("stream_sync_status");
  });

  it("does NOT register sync tools when ledger is null", () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      embedder: new FakeEmbedder(),
      cloudEndpoint: "http://localhost:9999",
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    expect(tools).not.toContain("stream_sync_push");
    expect(tools).not.toContain("stream_sync_pull");
    expect(tools).not.toContain("stream_sync_status");
  });

  it("registers all three sync tools when ledger + cloudEndpoint are present", () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      ledger,
      embedder: new FakeEmbedder(),
      cloudEndpoint: "http://localhost:9999",
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    expect(tools).toContain("stream_sync_push");
    expect(tools).toContain("stream_sync_pull");
    expect(tools).toContain("stream_sync_status");
  });
});

describe("stream_sync_status", () => {
  it("returns a status object with the expected fields when no syncs have occurred", async () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      ledger,
      embedder: new FakeEmbedder(),
      cloudEndpoint: "http://localhost:9999",
    });
    const body = parseResponse(
      await callTool(server, "stream_sync_status", {})
    );
    expect(body).toMatchObject({
      status: "ok",
      cloud_endpoint: "http://localhost:9999",
      last_pushed_local_id: 0,
      last_pulled_server_seq: 0,
      last_sync_at: null,
      pending_events_to_push: 0,
    });
  });
});

describe("scope enforcement: global-mutation rejected when scopes is set", () => {
  it("stream_sync_push and stream_sync_pull are rejected; stream_sync_status still works", async () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      ledger,
      embedder: new FakeEmbedder(),
      cloudEndpoint: "http://localhost:9999",
      serveOptions: { scopes: ["discord"], agentId: "a1" },
    });

    const pushBody = parseResponse(
      await callTool(server, "stream_sync_push", {})
    );
    expect(pushBody.status).toBe("out_of_scope");
    expect(pushBody.error).toBe("OUT_OF_SCOPE");

    const pullBody = parseResponse(
      await callTool(server, "stream_sync_pull", {})
    );
    expect(pullBody.status).toBe("out_of_scope");

    // global-read is always allowed.
    const statusBody = parseResponse(
      await callTool(server, "stream_sync_status", {})
    );
    expect(statusBody.status).toBe("ok");
  });
});

describe("readonly mode strips push/pull (mutating)", () => {
  it("stream_sync_push and stream_sync_pull are not registered under readonly", () => {
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey: ledger.getMasterKey(),
      userDir: tmpHome,
      ledger,
      embedder: new FakeEmbedder(),
      cloudEndpoint: "http://localhost:9999",
      serveOptions: { readonly: true, agentId: "a1" },
    });
    const tools = Object.keys((server as AnyServer)._registeredTools);
    expect(tools).not.toContain("stream_sync_push");
    expect(tools).not.toContain("stream_sync_pull");
    // stream_sync_status is read-only -> still registered.
    expect(tools).toContain("stream_sync_status");
  });
});
