/**
 * Configuration I/O for the USRCP Slack adapter.
 *
 * Exports:
 *   getConfigPath()      — path to ~/.usrcp/slack-config.json
 *   writeSlackConfig()   — write config at mode 0600
 *   readPartialConfig()  — read whatever fields are present on disk (exported for setup.ts)
 *   loadConfig()         — read-or-throw (non-interactive)
 *
 * Interactive setup lives in ./setup.ts → runSlackSetup().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SlackConfig {
  slack_bot_token: string;        // xoxb-...
  slack_app_token: string;        // xapp-...
  anthropic_api_key: string;
  allowlisted_channels: string[]; // C... or D... IDs
  user_id: string;                // U... — the workspace user ID (not the bot's)
}

const CONFIG_FILENAME = "slack-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

export function readPartialConfig(): Partial<SlackConfig> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConfig>;
  } catch {
    return {};
  }
}

/** @internal — use writeSlackConfig externally */
function writeConfig(cfg: SlackConfig): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(cfg, null, 2);
  // Write with O_WRONLY | O_CREAT | O_TRUNC + 0600. Open via fs.openSync
  // to guarantee the permission bits are honored regardless of umask.
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
 * Public alias for writeConfig — used by setup.ts so it doesn't need to
 * re-implement the secure write logic.
 */
export const writeSlackConfig: (cfg: SlackConfig) => void = writeConfig;

/**
 * Read-or-throw non-interactive loader. Called by the adapter's main() on
 * every boot. If config is missing or incomplete, exits with a clear message
 * pointing the user at 'usrcp setup'.
 */
export function loadConfig(): SlackConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) {
    console.error(
      `usrcp-slack: no config found at ${p}.\n` +
      `Run 'usrcp setup' (or 'usrcp setup --adapter=slack') to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<SlackConfig>;
  try {
    partial = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SlackConfig>;
  } catch {
    console.error(
      `usrcp-slack: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=slack' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.slack_bot_token) missing.push("slack_bot_token");
  if (!partial.slack_app_token) missing.push("slack_app_token");
  if (!partial.anthropic_api_key) missing.push("anthropic_api_key");
  if (!partial.allowlisted_channels || partial.allowlisted_channels.length === 0) missing.push("allowlisted_channels");
  if (!partial.user_id) missing.push("user_id");
  if (missing.length > 0) {
    console.error(
      `usrcp-slack: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=slack' to re-configure.`
    );
    process.exit(1);
  }
  return partial as SlackConfig;
}
