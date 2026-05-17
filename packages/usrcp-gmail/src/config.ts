import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Config for the Gmail adapter. Same plaintext-on-disk-mode-0600
 * posture as the Linear API key and the Google Calendar adapter -
 * treat this file like ~/.ssh/id_rsa. The refresh_token grants
 * long-lived read access to the user's Gmail; rotating it requires
 * revoking the access in https://myaccount.google.com/permissions
 * and re-running setup.
 */
export interface GmailConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 600 = 10 min). */
  poll_interval_s: number;
  /**
   * ISO timestamp; queries use `after:` Gmail-query syntax with the
   * unix seconds form of this value. Gmail's search resolution is
   * 1 second, so the cursor advances in seconds.
   */
  last_synced_at?: string;
}

const CONFIG_FILENAME = "gmail-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<GmailConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<GmailConfig>;
  } catch {
    return {};
  }
}

export function writeGmailConfig(cfg: GmailConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(p, 0o600);
}

export function loadConfig(): GmailConfig {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-gmail: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=gmail' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<GmailConfig>;
  try {
    partial = JSON.parse(raw) as Partial<GmailConfig>;
  } catch {
    console.error(
      `usrcp-gmail: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=gmail' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.oauth_client_id) missing.push("oauth_client_id");
  if (!partial.oauth_client_secret) missing.push("oauth_client_secret");
  if (!partial.refresh_token) missing.push("refresh_token");
  if (!partial.domain) missing.push("domain");
  if (typeof partial.poll_interval_s !== "number") missing.push("poll_interval_s");
  if (missing.length > 0) {
    console.error(
      `usrcp-gmail: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=gmail' to re-configure.`
    );
    process.exit(1);
  }
  return partial as GmailConfig;
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
  if (
    !existing.oauth_client_id ||
    !existing.oauth_client_secret ||
    !existing.refresh_token ||
    !existing.domain ||
    typeof existing.poll_interval_s !== "number"
  ) {
    _pendingTs = undefined;
    return;
  }
  try {
    writeGmailConfig({ ...(existing as GmailConfig), last_synced_at: _pendingTs });
  } catch {
    /* Non-fatal: next restart may re-process a few messages. */
  }
  _pendingTs = undefined;
}
