/**
 * Cline VS Code extension adapter (platform-specific globalStorage path)
 *
 * Uses the same path as getClientConfigPath("cline") in the main CLI.
 * We replicate the logic here to keep this module self-contained and avoid
 * a circular import with the main index.ts.
 *
 * macOS: ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 * Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 * Linux: $XDG_CONFIG_HOME/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readOrNull } from "./shared.js";

const TARGET = "cline";
const EXT = "json";

function configPath(): string {
  const home = homedir();
  const rel = join("saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "globalStorage", rel);
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appdata, "Code", "User", "globalStorage", rel);
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(home, ".config"),
    "Code", "User", "globalStorage", rel,
  );
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(join(CONFIG, ".."), { recursive: true });

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
    // malformed JSON
  }
  return "not_registered";
}
