/**
 * captureGitHubActivity is pure: takes a flattened activity record
 * (not the Octokit client) so it tests trivially without mocking
 * REST. The poller translates SDK objects into PullRequestActivity.
 *
 * Idempotency keys: `github:pr:<owner>/<repo>#<number>` - a PR's
 * stable identifier. If we ever capture multiple state changes per
 * PR (opened, merged, closed) we add a suffix here.
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

export function captureGitHubActivity(
  ledger: CaptureLedger,
  activity: PullRequestActivity,
  config: GitHubConfig,
): CaptureOutcome {
  // If the user set an allowlist and this repo isn't in one of the
  // allowed orgs, skip. User-owned repos (org === null) always pass
  // when no allowlist is configured, and are blocked when one is.
  if (config.allowlisted_orgs.length > 0) {
    if (!activity.org || !config.allowlisted_orgs.includes(activity.org)) {
      return { captured: false, reason: "org_not_allowlisted" };
    }
  }

  if (!activity.title || activity.title.trim().length === 0) {
    return { captured: false, reason: "empty_title" };
  }

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
      // channel_id = stable PR identifier so when v1.1 starts capturing
      // pr_merged / pr_closed events, they group with pr_opened in
      // getRecentEventsByChannel.
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
