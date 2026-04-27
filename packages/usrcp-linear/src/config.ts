import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LinearConfig {
  linear_api_key: string;
  /**
   * Linear API keys are workspace-scoped, so the allowlist gives multi-team
   * users fine-grained control over which work shows up in USRCP.
   */
  allowlisted_team_ids: string[];
  domain: string;
  poll_interval_s: number;
  /** ISO timestamp; queries use createdAt >= last_synced_at. */
  last_synced_at?: string;
}

const CONFIG_FILENAME = "linear-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<LinearConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<LinearConfig>;
  } catch {
    return {};
  }
}

export function writeLinearConfig(cfg: LinearConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  // O_CREAT mode is a no-op if the file already existed.
  fs.chmodSync(p, 0o600);
}

export function loadConfig(): LinearConfig {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-linear: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=linear' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<LinearConfig>;
  try {
    partial = JSON.parse(raw) as Partial<LinearConfig>;
  } catch {
    console.error(
      `usrcp-linear: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=linear' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.linear_api_key) missing.push("linear_api_key");
  if (!partial.allowlisted_team_ids || partial.allowlisted_team_ids.length === 0) {
    missing.push("allowlisted_team_ids");
  }
  if (!partial.domain) missing.push("domain");
  if (typeof partial.poll_interval_s !== "number") missing.push("poll_interval_s");
  if (missing.length > 0) {
    console.error(
      `usrcp-linear: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=linear' to re-configure.`
    );
    process.exit(1);
  }
  return partial as LinearConfig;
}

let _pendingTs: string | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

export function saveLastSyncedAt(ts: string): void {
  _pendingTs = ts;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushLastSyncedAt();
  }, 500);
}

export function flushLastSyncedAt(): void {
  if (_pendingTs === undefined) return;
  const existing = readPartialConfig();
  // Bail if the on-disk config is gone or stripped — better to lose the
  // cursor than overwrite a missing key/team list with empty strings.
  if (
    !existing.linear_api_key ||
    !existing.allowlisted_team_ids?.length ||
    !existing.domain ||
    typeof existing.poll_interval_s !== "number"
  ) {
    _pendingTs = undefined;
    return;
  }
  try {
    writeLinearConfig({ ...(existing as LinearConfig), last_synced_at: _pendingTs });
  } catch {
    // Non-fatal — next restart may re-process a few events.
  }
  _pendingTs = undefined;
}
