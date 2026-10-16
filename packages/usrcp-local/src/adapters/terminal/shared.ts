/**
 * Shared helpers for terminal adapter modules.
 * Atomic write + backup pattern used by every target.
 */

import { promises as fs } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { requireHomeDir, getUserSlug } from "usrcp-core/encryption";

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

/** Use this installation, never an unrelated older executable on PATH. */
export function resolveUsrcpBin(): string {
  const entry = resolve(__dirname, "../../index.js");
  if (existsSync(entry)) return entry;
  const invoked = process.argv[1];
  if (invoked && isAbsolute(invoked) && existsSync(invoked)) return invoked;
  throw new Error("Cannot locate this USRCP installation. Reinstall USRCP before registering clients.");
}

/** JS entrypoints need the absolute Node executable in GUI hosts too. */
export function serverCommand(bin: string, args: string[], previous?: unknown): { command: string; args: string[] } {
  const entry = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
  const oldArgs = Array.isArray(entry.args) ? entry.args : Array.isArray(entry.command) ? entry.command.slice(1) : [];
  const restrictions: string[] = [];
  for (let i = 0; i < oldArgs.length; i++) {
    const arg = oldArgs[i];
    if (typeof arg !== "string") continue;
    if (/^--(?:readonly|no-audit)$/.test(arg) || /^--(?:scopes|read-scopes|write-scopes|agent-id)=/.test(arg)) restrictions.push(arg);
    else if (/^--(?:scopes|read-scopes|write-scopes|agent-id)$/.test(arg)) {
      if (typeof oldArgs[i + 1] !== "string" || oldArgs[i + 1].startsWith("--")) throw new Error("Invalid existing scope option; repair it before reconnecting");
      restrictions.push(arg + "=" + oldArgs[++i]);
    }
  }
  if (restrictions.some(arg => arg.startsWith("--agent-id="))) args = args.filter(arg => !arg.startsWith("--agent-id="));
  args = [...args, ...restrictions];
  return /\.[cm]?js$/i.test(bin)
    ? { command: process.execPath, args: [bin, ...args] }
    : { command: bin, args };
}

/** Retain authentication, scopes and host approval settings when reconnecting. */
export function preserveServerOptions(previous: unknown): Record<string, unknown> {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return {};
  const { command, args, url, serverUrl, httpUrl, type, ...options } = previous as Record<string, unknown>;
  return options;
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
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  if (existingRaw !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(join(backupDir, `${targetName}.${stamp}.${randomBytes(4).toString("hex")}.${ext}`), existingRaw, { mode: 0o600, flag: "wx" });
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}


/** Pin the selected ledger so adding another user cannot redirect this client. */
export function terminalServeArgs(): string[] {
  return ["serve", "--stdio", "--user=" + getUserSlug()];
}
