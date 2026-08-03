/**
 * Shared helpers for terminal adapter modules.
 * Atomic write + backup pattern used by every target.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { requireHomeDir } from "usrcp-core/encryption";

/**
 * Home directory for terminal-adapter config writes, guarded (#174).
 *
 * Delegates to usrcp-core's requireHomeDir(), which throws when HOME is empty
 * or not absolute (e.g. whitespace). Every terminal-adapter path is anchored on
 * this, so under a broken HOME the adapter refuses instead of joining onto ""
 * and writing a relative `.codex/`, `.cursor/`, `.usrcp/` etc. into the process
 * CWD. Evaluated at call time so tests can override HOME.
 */
export function homeDir(): string {
  return requireHomeDir();
}

/** Returns the backup dir path, evaluated at call time so tests can override HOME. */
export function getBackupDir(): string {
  return join(homeDir(), ".usrcp", "backups");
}

/**
 * Resolve the absolute path to the usrcp binary.
 *
 * Strategy (in priority order):
 *  1. Try `which usrcp` — returns the globally installed binary path.
 *  2. Fall back to `process.argv[1]` — the running script's absolute path.
 *
 * We do NOT use `process.execPath` alone because that gives Node itself
 * (e.g., `/usr/local/bin/node`), not the usrcp script. We want the path
 * that an MCP host can invoke directly.
 */
export function resolveUsrcpBin(): string {
  try {
    const result = execSync("which usrcp", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const resolved = result.trim();
    if (resolved) return resolved;
  } catch {
    // `which` not found or usrcp not on PATH — fall back below
  }
  return process.argv[1];
}

/**
 * Write a config file atomically with a prior backup.
 *
 * @param configPath  Absolute path of the config file.
 * @param content     String to write.
 * @param ext         File extension for the backup file (e.g. "json", "toml", "yml").
 * @param targetName  Short name used in the backup filename (e.g. "cursor").
 * @param existingRaw The raw content before modification, or null if file was absent.
 */
export async function atomicWrite(
  configPath: string,
  content: string,
  ext: string,
  targetName: string,
  existingRaw: string | null,
): Promise<void> {
  const backupDir = getBackupDir();
  await fs.mkdir(backupDir, { recursive: true });

  if (existingRaw !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(join(backupDir, `${targetName}.${stamp}.${ext}`), existingRaw);
  }

  // Random tmp name + exclusive create ("wx" fails if the path already exists)
  // so a pre-planted predictable tmp file can't redirect or race the write.
  const tmp = `${configPath}.tmp_${randomBytes(8).toString("hex")}`;
  await fs.writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  await fs.rename(tmp, configPath);
}

/** Read a file, returning null if it doesn't exist. */
export async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
