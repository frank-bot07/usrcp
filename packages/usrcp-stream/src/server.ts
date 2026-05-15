import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  initializeMasterKey,
  getUserDir,
} from "usrcp-local/dist/encryption.js";
import { OllamaEmbedder, pingOllama } from "./embeddings/ollama.js";
import {
  registerStreamTools,
  type StreamServeOptions,
} from "./register.js";

export interface CreateStreamServerOptions extends StreamServeOptions {
  // Override embedder construction (used by tests and advanced callers).
  // When undefined: probe Ollama and use it if reachable; otherwise no
  // embedder — capture still works but recall returns no hits.
  embedder?: ConstructorParameters<typeof OllamaEmbedder>[0] | null;
}

export async function createStreamServer(
  passphrase?: string,
  opts: CreateStreamServerOptions = {}
): Promise<{ server: McpServer; shutdown: () => void }> {
  const masterKey = initializeMasterKey(passphrase);
  const userDir = getUserDir();

  let embedder = null;
  if (opts.embedder !== null) {
    if (await pingOllama()) {
      embedder = new OllamaEmbedder(opts.embedder ?? {});
    }
  }

  const server = new McpServer({
    name: "usrcp-stream",
    version: "0.0.1",
  });

  const { shutdown } = registerStreamTools(server, {
    masterKey,
    userDir,
    embedder,
    serveOptions: {
      scopes: opts.scopes,
      readonly: opts.readonly,
      noAudit: opts.noAudit,
      agentId: opts.agentId,
    },
  });

  return { server, shutdown };
}
