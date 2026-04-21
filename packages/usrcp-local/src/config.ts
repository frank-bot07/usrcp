/**
 * Per-user configuration file at ~/.usrcp/users/<slug>/config.json.
 *
 * Holds sync-related state: hosted ledger endpoint, cursor offsets. Not
 * secret — the master key stays in keys/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDir, safeWriteFile } from "./encryption.js";

export interface UsrcpConfig {
  cloud_endpoint?: string;
  last_push_local_seq?: number;
  last_pull_remote_cursor?: number;
  last_sync_at?: string; // ISO
}

export function getConfigPath(): string {
  return path.join(getUserDir(), "config.json");
}

export function readConfig(): UsrcpConfig {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as UsrcpConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: UsrcpConfig): void {
  fs.mkdirSync(getUserDir(), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(cfg, null, 2);
  safeWriteFile(getConfigPath(), Buffer.from(payload, "utf8"), 0o600);
}

export function updateConfig(partial: Partial<UsrcpConfig>): UsrcpConfig {
  const next = { ...readConfig(), ...partial };
  writeConfig(next);
  return next;
}
