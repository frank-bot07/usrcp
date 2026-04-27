/**
 * Configuration I/O for the USRCP Obsidian adapter.
 *
 * Exports:
 *   getConfigPath()         — path to ~/.usrcp/obsidian-config.json
 *   writeObsidianConfig()   — write config at mode 0600 (atomic)
 *   readPartialConfig()     — read whatever fields are present on disk
 *   loadConfig()            — read-or-throw (non-interactive)
 *
 * Interactive setup lives in ./setup.ts → runObsidianSetup().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ObsidianConfig {
  /** Absolute path to the vault directory. */
  vault_path: string;
  /**
   * Subdirectories (relative to vault_path) to capture from. Empty array
   * or undefined = capture from anywhere in the vault. "" represents the
   * vault root itself.
   */
  allowed_subdirs?: string[];
  /**
   * Subdirectories (relative to vault_path) to skip. Exclusion takes
   * precedence over allowed_subdirs.
   */
  excluded_subdirs?: string[];
  /**
   * If set, only capture notes that have at least one of these tags.
   * Tags are matched WITHOUT the leading '#'.
   */
  allowed_tags?: string[];
  /** Skip notes that have any of these tags (without leading '#'). */
  excluded_tags?: string[];
  /** USRCP domain to write events under. Default: "obsidian". */
  domain: string;
  /**
   * Per-file debounce window in milliseconds. Obsidian writes the file
   * many times during a single edit session (auto-save), so we coalesce
   * within this window before capturing. Default: 1500.
   */
  debounce_ms: number;
}

const CONFIG_FILENAME = "obsidian-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<ObsidianConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ObsidianConfig>;
  } catch {
    return {};
  }
}

function writeConfig(cfg: ObsidianConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  // Re-chmod defensively — O_CREAT mode is a no-op if the file already existed.
  fs.chmodSync(p, 0o600);
}

export const writeObsidianConfig: (cfg: ObsidianConfig) => void = writeConfig;

/**
 * Read-or-exit non-interactive loader. Called by the watcher's main() on
 * boot. If config is missing or incomplete, exits with a clear message.
 */
export function loadConfig(): ObsidianConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-obsidian: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=obsidian' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<ObsidianConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ObsidianConfig>;
  } catch {
    console.error(
      `usrcp-obsidian: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=obsidian' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.vault_path) missing.push("vault_path");
  if (!partial.domain) missing.push("domain");
  if (typeof partial.debounce_ms !== "number") missing.push("debounce_ms");
  if (missing.length > 0) {
    console.error(
      `usrcp-obsidian: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=obsidian' to re-configure.`
    );
    process.exit(1);
  }
  if (!fs.existsSync(partial.vault_path!)) {
    console.error(
      `usrcp-obsidian: vault_path does not exist: ${partial.vault_path}\n` +
      `Run 'usrcp setup --adapter=obsidian' to re-configure.`
    );
    process.exit(1);
  }
  return partial as ObsidianConfig;
}
