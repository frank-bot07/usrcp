/**
 * Aider adapter (~/.aider.conf.yml)
 *
 * Aider doesn't speak MCP. Instead, we add CONTEXT.md to its `read:` directive
 * so every aider session gets USRCP context at session start.
 *
 * If `read:` already exists as a scalar or list, we merge — never overwrite.
 * We add ~/.usrcp/CONTEXT.md if it's not already present.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import { atomicWrite, readOrNull } from "./shared.js";

const TARGET = "aider";
const EXT = "yml";

function configPath(): string {
  return join(homedir(), ".aider.conf.yml");
}

function contextMdPath(): string {
  return join(homedir(), ".usrcp", "CONTEXT.md");
}

export async function register(_usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }> {
  const CONFIG = configPath();
  const CONTEXT_MD = contextMdPath();

  const existingRaw = await readOrNull(CONFIG);
  // Parse with yaml — preserves comments is not guaranteed but we're merging carefully.
  const doc: Record<string, unknown> = existingRaw ? (YAML.parse(existingRaw) ?? {}) : {};

  // Normalize `read` to an array, merge in CONTEXT.md if not already present.
  let readList: string[];
  if (!Object.prototype.hasOwnProperty.call(doc, "read") || doc.read === null || doc.read === undefined) {
    readList = [];
  } else if (Array.isArray(doc.read)) {
    readList = (doc.read as unknown[]).map(String);
  } else {
    // scalar — wrap it
    readList = [String(doc.read)];
  }

  if (!readList.includes(CONTEXT_MD)) {
    readList.push(CONTEXT_MD);
  }
  doc.read = readList;

  await atomicWrite(CONFIG, YAML.stringify(doc), EXT, TARGET, existingRaw);
  return { target: TARGET, path: CONFIG, ok: true };
}

export async function unregister(): Promise<void> {
  const CONFIG = configPath();
  const CONTEXT_MD = contextMdPath();

  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return;

  const doc: Record<string, unknown> = YAML.parse(existingRaw) ?? {};

  if (Array.isArray(doc.read)) {
    doc.read = (doc.read as unknown[]).map(String).filter((p) => p !== CONTEXT_MD);
    if ((doc.read as string[]).length === 0) {
      delete doc.read;
    }
  } else if (typeof doc.read === "string" && doc.read === CONTEXT_MD) {
    delete doc.read;
  }

  await atomicWrite(CONFIG, YAML.stringify(doc), EXT, TARGET, existingRaw);
}

export async function status(): Promise<"registered" | "not_registered" | "config_missing"> {
  const CONFIG = configPath();
  const CONTEXT_MD = contextMdPath();

  const existingRaw = await readOrNull(CONFIG);
  if (!existingRaw) return "config_missing";

  try {
    const doc: Record<string, unknown> = YAML.parse(existingRaw) ?? {};
    if (Array.isArray(doc.read) && (doc.read as unknown[]).map(String).includes(CONTEXT_MD)) {
      return "registered";
    }
    if (typeof doc.read === "string" && doc.read === CONTEXT_MD) {
      return "registered";
    }
  } catch {
    // malformed YAML
  }
  return "not_registered";
}
