import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  deriveGlobalEncryptionKey,
  zeroBuffer,
} from "usrcp-local/dist/encryption.js";

export interface GitHubConfig {
  /**
   * GitHub personal access token. Either classic (`ghp_*`) or
   * fine-grained (`github_pat_*`). Encrypted at rest under the
   * USRCP global key.
   */
  github_token: string;
  /** GitHub login (username) - filters activity to PRs YOU authored. */
  github_login: string;
  /**
   * Optional org slug allowlist. If empty, captures across every
   * repo your token can see. If set, GitHub search filters server-side
   * via `org:<slug>` clauses so other orgs' PRs are never fetched.
   */
  allowlisted_orgs: string[];
  /** USRCP domain to write events under. */
  domain: string;
  /** Polling interval in seconds (default 600 = 10 min). */
  poll_interval_s: number;
  /**
   * Cursor for `pr_opened` events. The PR-opened query uses
   * `created:>{last_synced_at}`. Named for v1 backwards compatibility;
   * "synced_at" is misleading now that there are three cursors, but
   * renaming would orphan existing on-disk configs.
   */
  last_synced_at?: string;
  /**
   * Cursor for `pr_merged` events. The PR-merged query uses
   * `merged:>{last_merged_at}`. Added in v1.1.
   */
  last_merged_at?: string;
  /**
   * Cursor for `pr_closed` (without merge) events. The query uses
   * `closed:>{last_closed_at} is:unmerged`. Added in v1.1.
   */
  last_closed_at?: string;
  /**
   * Cursor for `issue_opened` events. Query uses
   * `created:>{last_issue_opened_at} type:issue`. Added in v1.2.
   */
  last_issue_opened_at?: string;
  /**
   * Cursor for `issue_commented` events. Query uses
   * `commenter:X updated:>{last_issue_commented_at}` to find
   * candidate issues/PRs, then `listComments(since=cursor)` per
   * candidate filtered by author. Added in v1.2.
   */
  last_issue_commented_at?: string;
}

/**
 * Field names of the five cursors, kept centralized so the save /
 * flush plumbing doesn't drift from the GitHubConfig shape.
 */
export type GitHubCursorField =
  | "last_synced_at"
  | "last_merged_at"
  | "last_closed_at"
  | "last_issue_opened_at"
  | "last_issue_commented_at";

const CONFIG_FILENAME = "github-config.json";

export function getConfigPath(): string {
  return path.join(os.homedir(), ".usrcp", CONFIG_FILENAME);
}

function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return encrypt(plaintext, key);
  } finally {
    zeroBuffer(key);
  }
}

function maybeDecryptSecret(value: string, masterKey: Buffer): string {
  if (!value.startsWith("enc:")) return value;
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return decrypt(value, key);
  } finally {
    zeroBuffer(key);
  }
}

export function readPartialConfig(): Partial<GitHubConfig> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Partial<GitHubConfig>;
  } catch {
    return {};
  }
}

/**
 * Like readPartialConfig, but decrypts the `enc:<base64>` envelope
 * on github_token back to plaintext so the setup wizard's "Enter to
 * keep existing key" default is the real PAT, not the encrypted
 * envelope.
 */
export function readPartialDecryptedConfig(masterKey: Buffer): Partial<GitHubConfig> {
  const partial = readPartialConfig();
  const out: Partial<GitHubConfig> = { ...partial };
  try {
    if (partial.github_token) {
      out.github_token = maybeDecryptSecret(partial.github_token, masterKey);
    }
  } catch {
    /* Best effort; wizard validation will catch decrypt failures. */
  }
  return out;
}

export function writeGitHubConfig(cfg: GitHubConfig, masterKey: Buffer): void {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const onDisk: GitHubConfig = {
    ...cfg,
    github_token: encryptSecret(cfg.github_token, masterKey),
  };
  const body = JSON.stringify(onDisk, null, 2);
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(p, 0o600);
}

/**
 * Read + validate the config without decrypting. Exits cleanly if the
 * file is missing, malformed, or incomplete. Shared by preflightConfig
 * (called before the Ledger is constructed) and loadConfig.
 */
function readValidatedPartial(): Partial<GitHubConfig> {
  const p = getConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    console.error(
      `usrcp-github: no config found at ${p}.\n` +
      `Run 'usrcp setup --adapter=github' to configure.`
    );
    process.exit(1);
  }
  let partial: Partial<GitHubConfig>;
  try {
    partial = JSON.parse(raw) as Partial<GitHubConfig>;
  } catch {
    console.error(
      `usrcp-github: failed to parse config at ${p}.\n` +
      `Run 'usrcp setup --adapter=github' to re-configure.`
    );
    process.exit(1);
  }
  const missing: string[] = [];
  if (!partial.github_token) missing.push("github_token");
  if (!partial.github_login) missing.push("github_login");
  if (!partial.domain) missing.push("domain");
  if (typeof partial.poll_interval_s !== "number") missing.push("poll_interval_s");
  if (missing.length > 0) {
    console.error(
      `usrcp-github: incomplete config (missing: ${missing.join(", ")}).\n` +
      `Run 'usrcp setup --adapter=github' to re-configure.`
    );
    process.exit(1);
  }
  return partial;
}

/**
 * Validate the on-disk config without needing the master key. The
 * daemon MUST call this before constructing the Ledger - otherwise a
 * fresh install with no github config silently auto-initializes a
 * dev-mode ledger and poisons a later `usrcp setup` run.
 */
export function preflightConfig(): void {
  readValidatedPartial();
}

export function loadConfig(masterKey: Buffer): GitHubConfig {
  const partial = readValidatedPartial();
  let decrypted: GitHubConfig;
  try {
    decrypted = {
      ...(partial as GitHubConfig),
      github_token: maybeDecryptSecret(partial.github_token!, masterKey),
      allowlisted_orgs: partial.allowlisted_orgs ?? [],
    };
  } catch (err) {
    console.error(
      `usrcp-github: failed to decrypt github_token (wrong passphrase or corrupt file): ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  // Auto-migrate legacy plaintext configs the moment we see them, so
  // an idle daemon doesn't leave the PAT plaintext on disk
  // indefinitely after the encryption rollout.
  if (!partial.github_token!.startsWith("enc:")) {
    try {
      writeGitHubConfig(decrypted, masterKey);
    } catch {
      /* Non-fatal; next save will retry. */
    }
  }
  return decrypted;
}

/**
 * Re-encrypt the on-disk config under a new master key. Used during
 * `usrcp_rotate_key` so the rotation doesn't leave this adapter
 * unable to decrypt its PAT on next boot.
 *
 * Returns "absent" if no config exists; "rotated" if successfully
 * re-encrypted. Throws on parse / decrypt failure - the dispatcher
 * logs the adapter as needing manual re-setup. Atomic per-file
 * (tmp + rename) so the file is either fully old-key or fully new-key.
 */
export function reencryptConfigUnderNewKey(
  oldKey: Buffer,
  newKey: Buffer,
): "absent" | "rotated" {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return "absent";

  const raw = fs.readFileSync(p, "utf8");
  const partial = JSON.parse(raw) as Partial<GitHubConfig>;
  if (!partial.github_token) {
    throw new Error(`incomplete github config at ${p}; cannot re-encrypt`);
  }

  const oldGlobal = deriveGlobalEncryptionKey(oldKey);
  const newGlobal = deriveGlobalEncryptionKey(newKey);
  try {
    const passthrough = (v: string) =>
      v.startsWith("enc:") ? decrypt(v, oldGlobal) : v;
    const onDisk = {
      ...partial,
      github_token: encrypt(passthrough(partial.github_token), newGlobal),
    };
    const body = JSON.stringify(onDisk, null, 2);
    const tmp = `${p}.rotate-tmp.${process.pid}.${Date.now()}`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
    return "rotated";
  } finally {
    zeroBuffer(oldGlobal);
    zeroBuffer(newGlobal);
  }
}

type PendingCursors = Partial<Record<GitHubCursorField, string>>;

let _pendingCursors: PendingCursors = {};
let _pendingMasterKey: Buffer | undefined;
let _flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Stage cursor advances and debounce a write 500ms out. Multiple
 * calls inside the window coalesce - only the latest value for each
 * field hits disk. A subsequent call with a different masterKey
 * replaces the pending one (no realistic case where the key would
 * mid-flight differ, but be explicit).
 */
export function saveCursors(
  cursors: PendingCursors,
  masterKey: Buffer,
): void {
  for (const k of Object.keys(cursors) as GitHubCursorField[]) {
    const v = cursors[k];
    if (v !== undefined) _pendingCursors[k] = v;
  }
  _pendingMasterKey = masterKey;
  if (_flushTimer !== undefined) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = undefined;
    flushCursors();
  }, 500);
}

export function flushCursors(): void {
  const pending = _pendingCursors;
  const masterKey = _pendingMasterKey;
  // Reset state regardless of write outcome - a failed write should
  // not leave stale pending state across the next save call.
  _pendingCursors = {};
  _pendingMasterKey = undefined;
  if (!masterKey || Object.keys(pending).length === 0) return;

  const existing = readPartialConfig();
  // Bail if the on-disk config is gone or stripped - better to lose
  // a cursor than overwrite a missing token with empty strings.
  if (
    !existing.github_token ||
    !existing.github_login ||
    !existing.domain ||
    typeof existing.poll_interval_s !== "number"
  ) {
    return;
  }
  try {
    const decrypted: GitHubConfig = {
      ...(existing as GitHubConfig),
      github_token: maybeDecryptSecret(existing.github_token!, masterKey),
      allowlisted_orgs: existing.allowlisted_orgs ?? [],
      ...pending,
    };
    writeGitHubConfig(decrypted, masterKey);
  } catch {
    // Non-fatal: next restart may re-process a few PRs.
  }
}

/** @deprecated since v1.1 - use `saveCursors({ last_synced_at: ts }, key)`. */
export function saveLastSyncedAt(ts: string, masterKey: Buffer): void {
  saveCursors({ last_synced_at: ts }, masterKey);
}

/** @deprecated since v1.1 - use `flushCursors()`. */
export function flushLastSyncedAt(): void {
  flushCursors();
}
