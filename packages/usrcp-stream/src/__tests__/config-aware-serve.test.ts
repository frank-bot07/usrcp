import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStreamTools } from "../register.js";
import { saveConfig, loadConfig, embedderFromConfig, configPath } from "../config-io.js";
import { OllamaEmbedder } from "../embeddings/ollama.js";
import { OpenAIEmbedder } from "../embeddings/openai.js";

// Codex P1-3: registerStreamTools and createStreamServer must consume the
// encrypted stream-config.toml written by `usrcp-stream init`. Before the
// fix, serve always probed Ollama and never read the saved config.

let tmpDir: string;
let masterKey: Buffer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-cfg-"));
  masterKey = crypto.randomBytes(32);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config-io roundtrip", () => {
  it("saveConfig + loadConfig encrypts at rest and decrypts on read", () => {
    const cfg = {
      embedding: {
        provider: "ollama" as const,
        model: "nomic-embed-text",
        host: "http://localhost:11434",
      },
    };
    saveConfig(masterKey, tmpDir, cfg);

    // Raw file is enc:-prefixed.
    const raw = fs.readFileSync(configPath(tmpDir), "utf-8").trim();
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw).not.toContain("nomic-embed-text");

    const round = loadConfig(masterKey, tmpDir);
    expect(round).toEqual(cfg);
  });

  it("loadConfig with wrong master key throws", () => {
    saveConfig(masterKey, tmpDir, { embedding: { provider: "ollama" } });
    const wrongKey = crypto.randomBytes(32);
    expect(() => loadConfig(wrongKey, tmpDir)).toThrow();
  });

  it("embedderFromConfig returns null when config is null", () => {
    expect(embedderFromConfig(null)).toBeNull();
  });

  it("embedderFromConfig builds an OllamaEmbedder for ollama provider", () => {
    const embedder = embedderFromConfig({
      embedding: { provider: "ollama", model: "mxbai-embed-large", host: "http://127.0.0.1:11434" },
    });
    expect(embedder).toBeInstanceOf(OllamaEmbedder);
    expect(embedder!.model).toBe("mxbai-embed-large");
  });

  it("embedderFromConfig refuses openai without vendor_consent", () => {
    const embedder = embedderFromConfig({
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      _api_key: "sk-fake",
    });
    expect(embedder).toBeNull();
  });

  it("embedderFromConfig builds an OpenAIEmbedder when vendor_consent + api key are present", () => {
    const embedder = embedderFromConfig({
      embedding: { provider: "openai", vendor_consent: true },
      _api_key: "sk-fake",
    });
    expect(embedder).toBeInstanceOf(OpenAIEmbedder);
  });
});

describe("registerStreamTools (Codex P1-3): wires embedder from saved config", () => {
  it("status tool reports the embedding model when wired from saved config", async () => {
    saveConfig(masterKey, tmpDir, {
      embedding: {
        provider: "ollama",
        model: "mxbai-embed-large",
        host: "http://localhost:11434",
      },
    });

    const server = new McpServer({ name: "t", version: "0.0.0" });
    const reg = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      // No embedder property = auto-load from config.
    });

    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }
      >;
    })._registeredTools;

    const res = await tools.stream_status.handler({});
    const body = JSON.parse(res.content[0].text);
    expect(body.embedding_model).toBe("mxbai-embed-large");
    reg.shutdown();
  });

  it("explicit embedder: null overrides saved config", async () => {
    saveConfig(masterKey, tmpDir, {
      embedding: { provider: "ollama", model: "nomic-embed-text" },
    });

    const server = new McpServer({ name: "t", version: "0.0.0" });
    const reg = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
      embedder: null,
    });

    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }
      >;
    })._registeredTools;

    const res = await tools.stream_status.handler({});
    const body = JSON.parse(res.content[0].text);
    expect(body.embedding_model).toBeNull();
    reg.shutdown();
  });

  it("no saved config + omitted embedder = null embedder", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const reg = registerStreamTools(server, {
      masterKey,
      userDir: tmpDir,
    });

    const tools = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }
      >;
    })._registeredTools;

    const res = await tools.stream_status.handler({});
    const body = JSON.parse(res.content[0].text);
    expect(body.embedding_model).toBeNull();
    reg.shutdown();
  });
});
