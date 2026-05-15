import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  initializeMasterKey,
  getUserDir,
} from "usrcp-local/dist/encryption.js";
import {
  registerStreamTools,
  type StreamServeOptions,
} from "./register.js";

export type CreateStreamServerOptions = StreamServeOptions;

export function createStreamServer(
  passphrase?: string,
  opts: CreateStreamServerOptions = {}
): { server: McpServer; shutdown: () => void } {
  const masterKey = initializeMasterKey(passphrase);
  const userDir = getUserDir();

  const server = new McpServer({
    name: "usrcp-stream",
    version: "0.0.1",
  });

  // registerStreamTools loads the configured provider from
  // ${userDir}/stream-config.toml when `embedder` is omitted (Codex P1-3).
  // When the file is absent, no embedder is wired and recall returns no
  // hits. Tests inject their own embedder via the property.
  const { shutdown } = registerStreamTools(server, {
    masterKey,
    userDir,
    serveOptions: {
      scopes: opts.scopes,
      readonly: opts.readonly,
      noAudit: opts.noAudit,
      agentId: opts.agentId,
    },
  });

  return { server, shutdown };
}
