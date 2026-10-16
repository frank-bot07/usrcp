import { existsSync } from "node:fs";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { terminalServeArgs, serverCommand, preserveServerOptions } from "./shared.js";
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
import { join } from "node:path";
import { atomicWrite, readOrNull, homeDir } from "./shared.js";

const TARGET = "opencode";
const EXT = "json";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homeDir(), ".config"), "opencode");
}

function configPath(): string {
  const jsonc = join(configDir(), "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(configDir(), "opencode.json");
}

function parseConfig(raw: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OpenCode configuration; left unchanged");
  return parsed;
}

export async function register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  await fs.mkdir(configDir(), { recursive: true });

  const existingRaw = await readOrNull(CONFIG);
  const doc: Record<string, unknown> = existingRaw && existingRaw.trim().length > 0 ? parseConfig(existingRaw) : {};

  if (!doc.mcp || typeof doc.mcp !== "object" || Array.isArray(doc.mcp)) {
    doc.mcp = {};
  }
  const launch = serverCommand(usrcpBin, [...terminalServeArgs(), "--agent-id=opencode"], (doc.mcp as Record<string, unknown>).usrcp);
  (doc.mcp as Record<string, unknown>).usrcp = {
    ...preserveServerOptions((doc.mcp as Record<string, unknown>).usrcp),
    type: "local",
    command: [launch.command, ...launch.args],
    enabled: true,
  };

  await atomicWrite(CONFIG, CONFIG.endsWith(".jsonc") && existingRaw ? applyEdits(existingRaw, modify(existingRaw, ["mcp", "usrcp"], (doc.mcp as Record<string, unknown>)?.usrcp, { formattingOptions: { insertSpaces: true, tabSize: 2 } })) : JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw || existingRaw.trim().length === 0) return;

  const doc: Record<string, unknown> = parseConfig(existingRaw);
  if (doc.mcp && typeof doc.mcp === "object" && !Array.isArray(doc.mcp)) {
    delete (doc.mcp as Record<string, unknown>).usrcp;
  }
  await atomicWrite(CONFIG, CONFIG.endsWith(".jsonc") && existingRaw ? applyEdits(existingRaw, modify(existingRaw, ["mcp", "usrcp"], (doc.mcp as Record<string, unknown>)?.usrcp, { formattingOptions: { insertSpaces: true, tabSize: 2 } })) : JSON.stringify(doc, null, 2), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const existingRaw = await readOrNull(CONFIG);
  if (existingRaw === null) return "config_missing";
  if (existingRaw.trim().length === 0) return "not_registered";

  try {
    const doc: Record<string, unknown> = parseConfig(existingRaw);
    const servers = doc.mcp;
    if (servers && typeof servers === "object" && !Array.isArray(servers) && "usrcp" in (servers as object)) {
      return "registered";
    }
  } catch {
    // malformed JSON
  }
  return "not_registered";
}
