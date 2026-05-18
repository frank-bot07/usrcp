/**
 * captureGitHubActivity is pure: takes a flattened activity record
 * (not the Octokit client) so it tests trivially without mocking
 * REST. The poller translates SDK objects into GitHubActivity.
 *
 * Idempotency keys per activity-type:
 *   pr_opened:        github:pr:<owner>/<repo>#<number>
 *   pr_merged:        github:pr-merged:<owner>/<repo>#<number>
 *   pr_closed:        github:pr-closed:<owner>/<repo>#<number>
 *   issue_opened:     github:issue:<owner>/<repo>#<number>
 *   issue_commented:  github:issue-comment:<comment_id>
 *
 * GitHub guarantees that a single PR fires at most one terminal
 * state event: `is:merged` and `is:closed is:unmerged` are
 * mutually exclusive in the search index, and merged is
 * irreversible.
 *
 * All events for the same issue/PR share
 * `channel_id = <owner>/<repo>#<number>`, including comments -
 * GitHub uses one numbering namespace per repo for issues+PRs, so
 * #42 is either an issue or a PR but not both. getRecentEventsByChannel
 * returns the full timeline including comments.
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

export interface IssueOpenedActivity {
  type: "issue_opened";
  node_id: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string | null;
  url: string;
  author_login: string;
  created_at: string;
  updated_at: string;
  state: "open" | "closed";
  org: string | null;
}

/**
 * A comment authored by the configured user on any issue or PR.
 * Note: GitHub's API treats every PR as also being an issue, so a
 * comment on a PR's main conversation tab arrives via this same path
 * (`/repos/.../issues/{n}/comments`). Inline review comments come
 * via a different endpoint and are out of scope for v1.2 (deferred
 * to the reviews PR).
 */
export interface IssueCommentActivity {
  type: "issue_commented";
  /** Stable GitHub comment ID. Used in the idempotency key. */
  comment_id: number;
  /** Comment's node_id (GraphQL global ID). */
  node_id: string;
  owner: string;
  repo: string;
  /** Issue or PR number the comment belongs to. */
  issue_number: number;
  /** Parent issue/PR title - context, not stored encrypted twice. */
  issue_title: string;
  /** True if the parent #<number> is a PR rather than a pure issue. */
  is_pr_parent: boolean;
  /** Browser URL of the comment itself. */
  url: string;
  /** Browser URL of the parent issue/PR. */
  issue_url: string;
  body: string;
  author_login: string;
  created_at: string;
  updated_at: string;
  org: string | null;
}

export type GitHubActivity =
  | PullRequestActivity
  | PullRequestStateChangeActivity
  | IssueOpenedActivity
  | IssueCommentActivity;

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "org_not_allowlisted" | "empty_title" | "empty_body";
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
  if (activity.type === "issue_commented") {
    // Comments have no title; emptiness is checked on body.
    if (!activity.body || activity.body.trim().length === 0) {
      return { captured: false, reason: "empty_body" };
    }
    return captureComment(ledger, activity, config);
  }
  if (!activity.title || activity.title.trim().length === 0) {
    return { captured: false, reason: "empty_title" };
  }
  if (activity.type === "pr_opened") return captureOpened(ledger, activity, config);
  if (activity.type === "issue_opened") return captureIssueOpened(ledger, activity, config);
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

function captureIssueOpened(
  ledger: CaptureLedger,
  activity: IssueOpenedActivity,
  config: GitHubConfig,
): CaptureOutcome {
  const repoFull = `${activity.owner}/${activity.repo}`;
  const summary = truncateSummary(`${repoFull}#${activity.number}: ${activity.title}`);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "issue_opened",
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
      },
      tags: ["github", "issue", repoFull],
      // Same channel_id format as PRs - GitHub uses one numbering
      // namespace per repo so #42 is either an issue or PR.
      channel_id: `${repoFull}#${activity.number}`,
      external_user_id: activity.author_login,
    },
    "github",
    `github:issue:${repoFull}#${activity.number}`,
    "github-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}

const COMMENT_BODY_PREVIEW_CHARS = 80;

function captureComment(
  ledger: CaptureLedger,
  activity: IssueCommentActivity,
  config: GitHubConfig,
): CaptureOutcome {
  const repoFull = `${activity.owner}/${activity.repo}`;
  // Comment summary fronts with the parent issue/PR reference so
  // timeline scans surface the work context, not the raw comment.
  const firstLine = activity.body.split(/\r?\n/)[0]!.trim();
  const preview =
    firstLine.length > COMMENT_BODY_PREVIEW_CHARS
      ? firstLine.slice(0, COMMENT_BODY_PREVIEW_CHARS - 1) + "…"
      : firstLine;
  const summary = truncateSummary(
    `${repoFull}#${activity.issue_number} comment: ${preview}`,
  );
  // Tag with the parent kind so callers can filter by
  // "comments on PRs" vs "comments on issues" without re-fetching.
  const parentKind = activity.is_pr_parent ? "pull-request" : "issue";
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "issue_commented",
      outcome: "success",
      detail: {
        comment_id: activity.comment_id,
        node_id: activity.node_id,
        owner: activity.owner,
        repo: activity.repo,
        issue_number: activity.issue_number,
        issue_title: activity.issue_title,
        is_pr_parent: activity.is_pr_parent,
        body: activity.body,
        url: activity.url,
        issue_url: activity.issue_url,
        author_login: activity.author_login,
        created_at: activity.created_at,
        updated_at: activity.updated_at,
      },
      tags: ["github", "comment", parentKind, repoFull],
      channel_id: `${repoFull}#${activity.issue_number}`,
      // thread_id = stable comment ID so callers can dedupe at the
      // (channel, thread) level if they want, and the timeline
      // preserves comment ordering within a parent.
      thread_id: String(activity.comment_id),
      external_user_id: activity.author_login,
    },
    "github",
    `github:issue-comment:${activity.comment_id}`,
    "github-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
