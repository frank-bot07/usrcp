/**
 * Continue.dev adapter (~/.continue/mcpServers/usrcp.json)
 *
 * The per-server-file approach: each MCP server gets its own JSON file under
 * ~/.continue/mcpServers/. This is complementary to the existing init path
 * which writes to ~/.continue/config.json under `mcpServers.usrcp`. Both are
 * supported by Continue.dev simultaneously; we don't touch config.json here.
 *
 * The file IS the entry — no nesting needed:
 *   { "name": "usrcp", "command": "<bin>", "args": ["serve", "--stdio"] }
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, readOrNull, getBackupDir } from "./shared.js";

const TARGET = "continue";
const EXT = "json";

function configPath(): string {
  return join(homedir(), ".continue", "mcpServers", "usrcp.json");
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(join(homedir(), ".continue", "mcpServers"), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const entry = {
    name: "usrcp",
    command: usrcpBin,
    args: ["serve", "--stdio"],
  };

  await atomicWrite(CONFIG, JSON.stringify(entry, null, 2), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return;

  // Remove the file entirely — it's solely the usrcp entry.
  // Back it up first.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = getBackupDir();
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(join(backupDir, `${TARGET}.${stamp}.${EXT}`), existingRaw);
  await fs.unlink(CONFIG);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return "config_missing";

  try {
    const doc = JSON.parse(existingRaw);
    // Any valid JSON file at this path means we're registered.
    if (doc && typeof doc === "object" && doc.name === "usrcp") {
      return "registered";
    }
  } catch {
    // malformed
  }
  return "not_registered";
}
