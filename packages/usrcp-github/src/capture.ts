/**
 * captureGitHubActivity is pure: takes a flattened activity record
 * (not the Octokit client) so it tests trivially without mocking
 * REST. The poller translates SDK objects into GitHubActivity.
 *
 * Idempotency keys are per (PR, activity-type):
 *   pr_opened:  github:pr:<owner>/<repo>#<number>
 *   pr_merged:  github:pr-merged:<owner>/<repo>#<number>
 *   pr_closed:  github:pr-closed:<owner>/<repo>#<number>
 *
 * GitHub guarantees that a single PR fires at most one terminal
 * state event in our pipeline: `is:merged` and `is:closed is:unmerged`
 * are mutually exclusive in the search index, and merged is
 * irreversible. So each PR ends up with one pr_opened + at most one
 * terminal event in the ledger.
 */

import type { GitHubConfig } from "./config.js";

export interface CaptureLedger {
  appendEvent(
    event: {
      domain: string;
      summary: string;
      intent: string;
      outcome: "success" | "partial" | "failed" | "abandoned";
      detail?: Record<string, unknown>;
      tags?: string[];
      channel_id?: string;
      thread_id?: string;
      external_user_id?: string;
    },
    platform: string,
    idempotencyKey?: string,
    agentId?: string
  ): { event_id: string; timestamp: string; ledger_sequence: number; duplicate?: boolean };
}

export interface PullRequestActivity {
  type: "pr_opened";
  /** GitHub's stable node_id. */
  node_id: string;
  /** PR number, scoped to the repo. */
  number: number;
  /** Repo owner login (user or org). */
  owner: string;
  /** Repo name. */
  repo: string;
  title: string;
  body: string | null;
  /** Browser URL to the PR. */
  url: string;
  /** Login of the PR author. */
  author_login: string;
  created_at: string;
  updated_at: string;
  /** "open" | "closed" - GitHub doesn't expose a merged-only state on the issue object. */
  state: "open" | "closed";
  /** True if the PR has been merged (separate from state, which can be "closed" without merge). */
  merged: boolean;
  /** Owning org slug, if the repo is org-owned; same as `owner` for org repos, null for user-owned repos. */
  org: string | null;
}

/**
 * Terminal-state PR event (v1.1). `state_at` is when the terminal
 * state happened on GitHub - `merged_at` for `pr_merged`, `closed_at`
 * for `pr_closed`. The poller uses this as the cursor for the next
 * tick's query.
 */
export interface PullRequestStateChangeActivity {
  type: "pr_merged" | "pr_closed";
  node_id: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  url: string;
  author_login: string;
  created_at: string;
  updated_at: string;
  /** ISO timestamp the terminal state happened. */
  state_at: string;
  org: string | null;
}

export type GitHubActivity = PullRequestActivity | PullRequestStateChangeActivity;

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "org_not_allowlisted" | "empty_title";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

const SUMMARY_MAX_CHARS = 200;

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function orgGated(
  activity: { org: string | null },
  config: GitHubConfig,
): boolean {
  if (config.allowlisted_orgs.length === 0) return false;
  if (!activity.org) return true;
  return !config.allowlisted_orgs.includes(activity.org);
}

export function captureGitHubActivity(
  ledger: CaptureLedger,
  activity: GitHubActivity,
  config: GitHubConfig,
): CaptureOutcome {
  if (orgGated(activity, config)) {
    return { captured: false, reason: "org_not_allowlisted" };
  }
  if (!activity.title || activity.title.trim().length === 0) {
    return { captured: false, reason: "empty_title" };
  }
  if (activity.type === "pr_opened") {
    return captureOpened(ledger, activity, config);
  }
  return captureStateChange(ledger, activity, config);
}

function captureOpened(
  ledger: CaptureLedger,
  activity: PullRequestActivity,
  config: GitHubConfig,
): CaptureOutcome {
  const repoFull = `${activity.owner}/${activity.repo}`;
  const summary = truncateSummary(`${repoFull}#${activity.number}: ${activity.title}`);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "pr_opened",
      outcome: "success",
      detail: {
        node_id: activity.node_id,
        number: activity.number,
        owner: activity.owner,
        repo: activity.repo,
        title: activity.title,
        body: activity.body,
        url: activity.url,
        author_login: activity.author_login,
        created_at: activity.created_at,
        updated_at: activity.updated_at,
        state: activity.state,
        merged: activity.merged,
      },
      tags: ["github", "pull-request", repoFull],
      // channel_id = stable PR identifier so pr_merged / pr_closed
      // group with pr_opened in getRecentEventsByChannel.
      channel_id: `${repoFull}#${activity.number}`,
      external_user_id: activity.author_login,
    },
    "github",
    `github:pr:${repoFull}#${activity.number}`,
    "github-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}

function captureStateChange(
  ledger: CaptureLedger,
  activity: PullRequestStateChangeActivity,
  config: GitHubConfig,
): CaptureOutcome {
  const repoFull = `${activity.owner}/${activity.repo}`;
  // The verb here matches the intent so timeline summaries read
  // naturally: "anthropics/usrcp#42 merged: Add the GitHub adapter".
  const verb = activity.type === "pr_merged" ? "merged" : "closed";
  const summary = truncateSummary(
    `${repoFull}#${activity.number} ${verb}: ${activity.title}`,
  );
  const idemSuffix = activity.type === "pr_merged" ? "pr-merged" : "pr-closed";
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: activity.type,
      outcome: "success",
      detail: {
        node_id: activity.node_id,
        number: activity.number,
        owner: activity.owner,
        repo: activity.repo,
        title: activity.title,
        url: activity.url,
        author_login: activity.author_login,
        created_at: activity.created_at,
        updated_at: activity.updated_at,
        state_at: activity.state_at,
      },
      tags: ["github", "pull-request", repoFull, verb],
      channel_id: `${repoFull}#${activity.number}`,
      external_user_id: activity.author_login,
    },
    "github",
    `github:${idemSuffix}:${repoFull}#${activity.number}`,
    "github-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
