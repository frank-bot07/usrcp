import * as fs from "node:fs";
import * as path from "node:path";
import { requireHomeDir } from "usrcp-core/encryption";

const CONFIG_FILE = "claude-code-config.json";

export interface ClaudeCodeConfig {
  /**
   * Absolute project paths (cwd values as Claude Code records them) the
   * user wants captured. Default empty - the adapter is a no-op until
   * the user explicitly opts a project in. Each path here is matched
   * against `cwd` in each JSONL turn record.
   */
  allowlisted_projects: string[];
  /**
   * Per-file byte offset resume cursor. The watcher updates these after
   * each successful poll tick and persists coalesced. On startup we
   * resume reading each JSONL from its stored offset; a file that has
   * shrunk since last seen is treated as new (offset reset to 0).
   */
  file_offsets: Record<string, number>;
  /** Poll interval in ms (default 2000). Configurable for tests. */
  poll_interval_ms?: number;
}

const DEFAULT_CONFIG: ClaudeCodeConfig = {
  allowlisted_projects: [],
  file_offsets: {},
};

export function getConfigPath(): string {
  // requireHomeDir(), not os.homedir(): under empty HOME os.homedir() is ""
  // and this join becomes a relative ".usrcp/..." written into the CWD
  // (#192, same class as #174/#183).
  return path.join(requireHomeDir(), ".usrcp", CONFIG_FILE);
}

export function getClaudeProjectsDir(): string {
  return path.join(requireHomeDir(), ".claude", "projects");
}

export function loadConfig(): ClaudeCodeConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ClaudeCodeConfig>;
    return {
      allowlisted_projects: parsed.allowlisted_projects ?? [],
      file_offsets: parsed.file_offsets ?? {},
      poll_interval_ms: parsed.poll_interval_ms,
    };
  } catch (err) {
    console.error(
      `[usrcp-claude-code] failed to parse ${p}: ${err instanceof Error ? err.message : err}. ` +
        `Using defaults.`
    );
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: ClaudeCodeConfig): void {
  const p = getConfigPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort
  }
}

// Coalesced offset flush: keep an in-memory dirty marker; debounce writes.
let pendingConfig: ClaudeCodeConfig | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;

export function setOffset(file: string, offset: number, configRef: ClaudeCodeConfig): void {
  configRef.file_offsets[file] = offset;
  scheduleFlush(configRef);
}

/**
 * Remove the offset entry for a file the watcher no longer tracks
 * (e.g. the JSONL was deleted by Claude Code's own session cleanup,
 * or the project directory was removed). Without this, file_offsets
 * grows unbounded across the lifetime of a long-running daemon,
 * surfaced by Codex Tier-2 #5.
 *
 * Returns true if an entry was actually removed; the caller can use
 * the return value to decide whether to log/audit the prune.
 */
export function deleteOffset(file: string, configRef: ClaudeCodeConfig): boolean {
  if (!(file in configRef.file_offsets)) return false;
  delete configRef.file_offsets[file];
  scheduleFlush(configRef);
  return true;
}

function scheduleFlush(configRef: ClaudeCodeConfig): void {
  pendingConfig = configRef;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    if (pendingConfig) saveConfig(pendingConfig);
    flushTimer = null;
    pendingConfig = null;
  }, FLUSH_INTERVAL_MS);
}

export function flushOffsets(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingConfig) {
    saveConfig(pendingConfig);
    pendingConfig = null;
  }
}

/**
 * Convert an absolute cwd path to the encoded directory name Claude
 * Code uses under ~/.claude/projects/. The encoding is "/" -> "-",
 * preserving the leading separator. Example:
 *   /Users/frankbot/usrcp  ->  -Users-frankbot-usrcp
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}
