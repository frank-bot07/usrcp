import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  initializeMasterKey,
  getUserDir,
} from "usrcp-core/encryption";
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
  //
  // Forward ALL StreamServeOptions fields - the explicit-field rebuild
  // used to silently drop new fields (codex PR #61 round-2 caught
  // readScopes / writeScopes leaking past the standalone server).
  const { shutdown } = registerStreamTools(server, {
    masterKey,
    userDir,
    serveOptions: opts,
  });

  return { server, shutdown };
}
