/**
 * Claude Code CLI adapter (~/.claude.json)
 *
 * Registers usrcp as an MCP server under the `mcpServers.usrcp` key.
 * Claude Code CLI reads ~/.claude.json (NOT ~/.config/Claude/claude_desktop_config.json
 * which is Claude Desktop — those are separate clients with separate config files).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readOrNull } from "./shared.js";

const TARGET = "claude-code";
const EXT = "json";

function configPath(): string {
  return join(homedir(), ".claude.json");
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(homedir(), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: Record<string, unknown> = existingRaw ? JSON.parse(existingRaw) : {};

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
  if (!existingRaw) return;

  const doc: Record<string, unknown> = JSON.parse(existingRaw);
  if (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)) {
    delete (doc.mcpServers as Record<string, unknown>).usrcp;
  }
  await atomicWrite(CONFIG, JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return "config_missing";

  try {
    const doc: Record<string, unknown> = JSON.parse(existingRaw);
    const servers = doc.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers) && "usrcp" in (servers as object)) {
      return "registered";
    }
  } catch {
    // malformed JSON — treat as not registered
  }
  return "not_registered";
}
