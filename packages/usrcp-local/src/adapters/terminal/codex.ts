import { terminalServeArgs } from "./shared.js";
/**
 * OpenAI Codex CLI adapter (~/.codex/config.toml)
 *
 * Registers usrcp under [mcp_servers.usrcp] in the TOML config.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { atomicWrite, readOrNull, homeDir } from "./shared.js";

const TARGET = "codex";
const EXT = "toml";

function configPath(): string {
  return join(homeDir(), ".codex", "config.toml");
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(join(homeDir(), ".codex"), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: TOML.JsonMap = existingRaw ? TOML.parse(existingRaw) : {};

  if (!doc.mcp_servers || typeof doc.mcp_servers !== "object" || Array.isArray(doc.mcp_servers)) {
    doc.mcp_servers = {};
  }
  (doc.mcp_servers as TOML.JsonMap).usrcp = {
    command: usrcpBin,
    args: [...terminalServeArgs(), "--agent-id=codex"],
  };

  await atomicWrite(CONFIG, TOML.stringify(doc), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return;

  const doc: TOML.JsonMap = TOML.parse(existingRaw);
  if (doc.mcp_servers && typeof doc.mcp_servers === "object" && !Array.isArray(doc.mcp_servers)) {
    delete (doc.mcp_servers as TOML.JsonMap).usrcp;
  }
  await atomicWrite(CONFIG, TOML.stringify(doc), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return "config_missing";

  try {
    const doc: TOML.JsonMap = TOML.parse(existingRaw);
    const servers = doc.mcp_servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers) && "usrcp" in (servers as object)) {
      return "registered";
    }
  } catch {
    // malformed TOML
  }
  return "not_registered";
}
