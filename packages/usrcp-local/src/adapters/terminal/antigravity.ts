import { serverCommand, preserveServerOptions } from "./shared.js";
import { terminalServeArgs } from "./shared.js";
/**
 * Google Antigravity adapter (~/.gemini/config/mcp_config.json; legacy IDE path retained)
 *
 * Antigravity is Google's VS Code-derived agentic editor (public preview
 * Nov 2025). It speaks the standard MCP `mcpServers` schema — same shape
 * as Claude Desktop / Cursor / Claude Code — so the registration pattern
 * mirrors cursor.ts.
 */

import { existsSync, promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { atomicWrite, readOrNull, homeDir } from "./shared.js";

const TARGET = "antigravity";
const EXT = "json";

export function getAntigravityConfigPath(home = homeDir()): string {
  const current = join(home, ".gemini", "config", "mcp_config.json");
  const legacy = join(home, ".gemini", "antigravity", "mcp_config.json");
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = getAntigravityConfigPath();
  await fs.mkdir(dirname(CONFIG), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: Record<string, unknown> = existingRaw && existingRaw.trim().length > 0 ? JSON.parse(existingRaw) : {};

  if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  (doc.mcpServers as Record<string, unknown>).usrcp = {
    ...preserveServerOptions((doc.mcpServers as Record<string, unknown>).usrcp),
    ...serverCommand(usrcpBin, terminalServeArgs(), (doc.mcpServers as Record<string, unknown>).usrcp),
  };

  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = getAntigravityConfigPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw || existingRaw.trim().length === 0) return;

  const doc: Record<string, unknown> = JSON.parse(existingRaw);
  if (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)) {
    delete (doc.mcpServers as Record<string, unknown>).usrcp;
  }
  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = getAntigravityConfigPath();
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
