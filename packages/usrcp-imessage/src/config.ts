/**
 * Configuration I/O for the USRCP iMessage adapter.
 *
 * Exports:
 *   getConfigPath()         — path to ~/.usrcp/imessage-config.json
 *   writeImessageConfig()   — write config at mode 0600 (atomic)
 *   readPartialConfig()     — read whatever fields are present on disk
 *   loadConfig()            — read-or-throw (non-interactive)
 *   saveLastRowid()         — debounced flush of last_rowid to disk
 *
 * Interactive setup lives in ./setup.ts → runImessageSetup().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ImessageConfig {
  anthropic_api_key: string;
  /** User's own iMessage handle — phone (e.g. +14155551234) or email. */
  user_handle: string;
  /** Chat ROWIDs (as strings) from chat.db — stable per install. */
  allowlisted_chats: string[];
  /** Trigger prefix for group chats. Default: "..u " */
  prefix: string;
  /** Resume cursor for `imsg watch --since-rowid`. Updated per-event. */
  last_rowid?: number;
}

const CONFIG_FILENAME = "imessage-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<ImessageConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ImessageConfig>;
  } catch {
    return {};
  }
}

/** @internal — use writeImessageConfig externally */
function writeConfig(cfg: ImessageConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  // Write with O_WRONLY | O_CREAT | O_TRUNC + 0600. Use fs.openSync to
  // guarantee permission bits are honored regardless of umask.
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  // Re-chmod defensively — openSync with mode only sets perms on creation.
  // If the file already existed, O_CREAT is a no-op and perms may stay stale.
  fs.chmodSync(p, 0o600);
}

/**
 * Public alias — used by setup.ts so it doesn't need to re-implement
 * the secure write logic.
 */
export const writeImessageConfig: (cfg: ImessageConfig) => void = writeConfig;

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main() on
 * every boot. If config is missing or incomplete, exits with a clear message.
 */
export function loadConfig(): ImessageConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-imessage: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=imessage' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<ImessageConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ImessageConfig>;
  } catch {
    console.error(
      `usrcp-imessage: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=imessage' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.user_handle) missing.push("user_handle");
  if (!partial.allowlisted_chats || partial.allowlisted_chats.length === 0) missing.push("allowlisted_chats");
  if (!partial.prefix) missing.push("prefix");
  if (missing.length > 0) {
    console.error(
      `usrcp-imessage: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=imessage' to re-configure.`
    );
    process.exit(1);
  }
  return partial as ImessageConfig;
}

// ---------------------------------------------------------------------------
// Debounced last_rowid persistence
//
// saveLastRowid() is called per-event in the hot path. We coalesce writes
// via a 500ms debounce timer so disk I/O doesn't track every message.
// On SIGINT the caller flushes explicitly (flushLastRowid()).
// ---------------------------------------------------------------------------

let _pendingRowid: number | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesced in-memory update; flushes to disk after 500ms of quiet. */
export function saveLastRowid(rowid: number): void {
  _pendingRowid = rowid;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushLastRowid();
  }, 500);
}

/** Immediately flush any pending rowid to disk. Call on SIGINT/SIGTERM. */
export function flushLastRowid(): void {
  if (_pendingRowid === undefined) return;
  const existing = readPartialConfig();
  const merged: ImessageConfig = {
    anthropic_api_key: existing.anthropic_api_key ?? "",
    user_handle: existing.user_handle ?? "",
    allowlisted_chats: existing.allowlisted_chats ?? [],
    prefix: existing.prefix ?? "..u ",
    ...existing,
    last_rowid: _pendingRowid,
  };
  try {
    writeConfig(merged);
  } catch {
    // Non-fatal — next restart may re-process a few events
  }
  _pendingRowid = undefined;
}
