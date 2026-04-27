/**
 * OpenCode adapter (~/.config/opencode/opencode.json)
 *
 * OpenCode (sst/opencode) is an open-source agentic CLI. Unlike Claude
 * Desktop / Cursor / Antigravity, OpenCode's MCP schema uses the top-level
 * `mcp` key (not `mcpServers`) and combines the binary + its args into a
 * single `command` array — there is no separate `args` field. The server
 * type must be `"local"` for stdio transport.
 *
 * Reference: https://opencode.ai/docs/mcp-servers
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readOrNull } from "./shared.js";

const TARGET = "opencode";
const EXT = "json";

function configDir(): string {
  return join(homedir(), ".config", "opencode");
}

function configPath(): string {
  return join(configDir(), "opencode.json");
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(configDir(), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: Record<string, unknown> = existingRaw && existingRaw.trim().length > 0 ? JSON.parse(existingRaw) : {};

  if (!doc.mcp || typeof doc.mcp !== "object" || Array.isArray(doc.mcp)) {
    doc.mcp = {};
  }
  (doc.mcp as Record<string, unknown>).usrcp = {
    type: "local",
    command: [usrcpBin, "serve", "--stdio"],
    enabled: true,
  };

  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw || existingRaw.trim().length === 0) return;

  const doc: Record<string, unknown> = JSON.parse(existingRaw);
  if (doc.mcp && typeof doc.mcp === "object" && !Array.isArray(doc.mcp)) {
    delete (doc.mcp as Record<string, unknown>).usrcp;
  }
  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (existingRaw === null) return "config_missing";
  if (existingRaw.trim().length === 0) return "not_registered";

  try {
    const doc: Record<string, unknown> = JSON.parse(existingRaw);
    const servers = doc.mcp;
    if (servers && typeof servers === "object" && !Array.isArray(servers) && "usrcp" in (servers as object)) {
      return "registered";
    }
  } catch {
    // malformed JSON
  }
  return "not_registered";
}
