import { createAdapterConfig } from "usrcp-adapter-kit";

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
  /**
   * Cursor for `pr_reviewed` events. Query uses
   * `reviewed-by:X type:pr updated:>{last_pr_reviewed_at}` to find
   * candidate PRs, then `pulls.listReviews` per candidate filtered
   * by reviewer + state + submitted_at. Added in v1.3.
   */
  last_pr_reviewed_at?: string;
}

/**
 * Field names of the six cursors, kept centralized so the save /
 * flush plumbing doesn't drift from the GitHubConfig shape.
 */
export type GitHubCursorField =
  | "last_synced_at"
  | "last_merged_at"
  | "last_closed_at"
  | "last_issue_opened_at"
  | "last_issue_commented_at"
  | "last_pr_reviewed_at";

const CURSOR_FIELDS: GitHubCursorField[] = [
  "last_synced_at",
  "last_merged_at",
  "last_closed_at",
  "last_issue_opened_at",
  "last_issue_commented_at",
  "last_pr_reviewed_at",
];

// Encrypted-at-rest config store — see usrcp-adapter-kit. GitHub is the
// multi-cursor case: six independent poll cursors, plus an optional
// org allowlist that defaults to [] on load.
const store = createAdapterConfig<GitHubConfig>({
  adapterName: "github",
  filename: "github-config.json",
  fields: [
    { name: "github_token", kind: "secret" },
    { name: "github_login", kind: "required" },
    { name: "domain", kind: "required" },
    { name: "poll_interval_s", kind: "requiredNumber" },
    { name: "allowlisted_orgs", kind: "optional", default: [] },
    ...CURSOR_FIELDS.map((name) => ({ name, kind: "optional" as const })),
  ],
  cursorFields: CURSOR_FIELDS,
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeGitHubConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;

/**
 * Stage cursor advances and debounce a write 500ms out. Multiple calls
 * inside the window coalesce — only the latest value for each field hits
 * disk.
 */
export const saveCursors = (
  cursors: Partial<Record<GitHubCursorField, string>>,
  masterKey: Buffer,
): void => store.saveCursors(cursors, masterKey);
export const flushCursors = store.flushCursors;

/** @deprecated since v1.1 - use `saveCursors({ last_synced_at: ts }, key)`. */
export const saveLastSyncedAt = (ts: string, masterKey: Buffer): void =>
  store.saveCursors({ last_synced_at: ts }, masterKey);
/** @deprecated since v1.1 - use `flushCursors()`. */
export const flushLastSyncedAt = store.flushCursors;
