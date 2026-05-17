import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Config for the Google Calendar adapter. OAuth credentials live in
 * this file plaintext-on-disk, same as the Linear API key in
 * usrcp-linear/config.ts: it's the user's machine; the file is
 * mode 0600; and the master USRCP master key is OUT of scope for
 * adapter configs by design (the adapter is just a feeder, not a
 * trust boundary).
 *
 * The refresh_token grants long-lived read access to the user's
 * Calendar API. Treat this file the same as ~/.ssh/id_rsa.
 */
export interface GoogleCalendarConfig {
  oauth_client_id: string;
  oauth_client_secret: string;
  /** Long-lived OAuth refresh token. Used to mint short-lived access tokens on each poll. */
  refresh_token: string;
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 300 = 5 min). */
  poll_interval_s: number;
  /** ISO timestamp; queries use updatedMin >= last_synced_at. */
  last_synced_at?: string;
}

const CONFIG_FILENAME = "google-calendar-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<GoogleCalendarConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<GoogleCalendarConfig>;
  } catch {
    return {};
  }
}

export function writeGoogleCalendarConfig(cfg: GoogleCalendarConfig): void {
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

export function loadConfig(): GoogleCalendarConfig {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-google-calendar: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=google-calendar' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<GoogleCalendarConfig>;
  try {
    partial = JSON.parse(raw) as Partial<GoogleCalendarConfig>;
  } catch {
    console.error(
      `usrcp-google-calendar: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=google-calendar' to re-configure.`
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
      `usrcp-google-calendar: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=google-calendar' to re-configure.`
    );
    process.exit(1);
  }
  return partial as GoogleCalendarConfig;
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
    writeGoogleCalendarConfig({ ...(existing as GoogleCalendarConfig), last_synced_at: _pendingTs });
  } catch {
    /* Non-fatal: next restart may re-process a few events. */
  }
  _pendingTs = undefined;
}
