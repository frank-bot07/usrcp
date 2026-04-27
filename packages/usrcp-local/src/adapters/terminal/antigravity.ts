/**
 * Google Antigravity adapter (~/.gemini/antigravity/mcp_config.json)
 *
 * Antigravity is Google's VS Code-derived agentic editor (public preview
 * Nov 2025). It speaks the standard MCP `mcpServers` schema — same shape
 * as Claude Desktop / Cursor / Claude Code — so the registration pattern
 * mirrors cursor.ts.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readOrNull } from "./shared.js";

const TARGET = "antigravity";
const EXT = "json";

function configDir(): string {
  return join(homedir(), ".gemini", "antigravity");
}

function configPath(): string {
  return join(configDir(), "mcp_config.json");
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(configDir(), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: Record<string, unknown> = existingRaw && existingRaw.trim().length > 0 ? JSON.parse(existingRaw) : {};

  if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  (doc.mcpServers as Record<string, unknown>).usrcp = {
    command: usrcpBin,
    args: ["serve", "--stdio"],
  };

  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw || existingRaw.trim().length === 0) return;

  const doc: Record<string, unknown> = JSON.parse(existingRaw);
  if (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)) {
    delete (doc.mcpServers as Record<string, unknown>).usrcp;
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
    const servers = doc.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers) && "usrcp" in (servers as object)) {
      return "registered";
    }
  } catch {
    // malformed JSON
  }
  return "not_registered";
}
