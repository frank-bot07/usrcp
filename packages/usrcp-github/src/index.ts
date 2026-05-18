#!/usr/bin/env node
/**
 * usrcp-github: capture-only adapter for PRs authored by the configured
 * user, filtered to optional allowlisted orgs.
 *
 * Polls the GitHub REST search API (issuesAndPullRequests) with three
 * queries per tick:
 *   1. `author:X type:pr created:><opened_cursor>`         - pr_opened
 *   2. `author:X type:pr is:merged merged:><merged_cursor>` - pr_merged
 *   3. `author:X type:pr is:closed is:unmerged closed:><closed_cursor>` - pr_closed
 *
 * Search is rate-limited to 30 req/min for authenticated users; three
 * paginated queries per 600s tick is well under the cap.
 *
 * Recursive setTimeout (not setInterval): a slow tick must delay the
 * next one, not queue overlapping ticks.
 *
 * Cursors advance independently. The same PR may appear in queries
 * (1) on one tick and (2)/(3) on a later tick; idempotency keys are
 * per (PR, activity-type) so each event lands once.
 */

import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  loadConfig,
  preflightConfig,
  saveCursors,
  flushCursors,
  type GitHubConfig,
} from "./config.js";
import {
  captureGitHubActivity,
  type CaptureLedger,
  type IssueCommentActivity,
  type IssueOpenedActivity,
  type PullRequestActivity,
  type PullRequestReviewActivity,
  type PullRequestStateChangeActivity,
} from "./capture.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// First-run lookback when a cursor is unset, so activity from the gap
// between `usrcp setup` and the daemon coming up isn't lost.
const FIRST_RUN_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * Parse the search API's `repository_url`
 * ("https://api.github.com/repos/{owner}/{repo}") into {owner, repo}.
 * Returns null if the URL is shaped unexpectedly (defensive against
 * future API shape changes).
 */
function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function orgQualifiers(config: GitHubConfig): string[] {
  if (config.allowlisted_orgs.length === 0) return [];
  return config.allowlisted_orgs.map((o) => `org:${o}`);
}

interface CursorState {
  opened: string;
  merged: string;
  closed: string;
  issue_opened: string;
  issue_commented: string;
  pr_reviewed: string;
}

export interface PollTickResult {
  opened: { captured: number; skipped: number; newCursor: string };
  merged: { captured: number; skipped: number; newCursor: string };
  closed: { captured: number; skipped: number; newCursor: string };
  issue_opened: { captured: number; skipped: number; newCursor: string };
  issue_commented: { captured: number; skipped: number; newCursor: string; failures: number };
  pr_reviewed: { captured: number; skipped: number; newCursor: string; failures: number };
}

interface BaseFields {
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
  org: string | null;
}

/**
 * Pull common fields out of an Octokit search result. The
 * `requirePr` flag distinguishes the PR-only queries (where the
 * search returns issues+PRs and we filter out pure issues) from the
 * issue-only queries (where we accept both pure issues and PRs).
 */
function toBaseFields(item: any, requirePr: boolean): BaseFields | null {
  if (requirePr && !item.pull_request) return null;
  const parsed = parseRepoUrl(item.repository_url);
  if (!parsed) return null;
  if (!item.user) return null;
  return {
    node_id: item.node_id,
    number: item.number,
    owner: parsed.owner,
    repo: parsed.repo,
    title: item.title,
    body: item.body ?? null,
    url: item.html_url,
    author_login: item.user.login,
    created_at: item.created_at,
    updated_at: item.updated_at,
    org: parsed.owner,
  };
}

async function runQuery(
  octokit: Octokit,
  q: string,
  sort: "created" | "updated",
): Promise<any[]> {
  return octokit.paginate(octokit.search.issuesAndPullRequests, {
    q,
    sort,
    order: "asc",
    per_page: 100,
  });
}

async function pollOpened(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  sinceIso: string,
): Promise<{ captured: number; skipped: number; newCursor: string }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;

  const q = [
    `author:${config.github_login}`,
    "type:pr",
    `created:>${sinceIso}`,
    ...orgQualifiers(config),
  ].join(" ");
  const items = await runQuery(octokit, q, "created");

  for (const item of items) {
    const base = toBaseFields(item, /*requirePr=*/ true);
    if (!base) continue;
    const activity: PullRequestActivity = {
      type: "pr_opened",
      ...base,
      state: item.state === "closed" ? "closed" : "open",
      merged: !!item.pull_request.merged_at,
    };
    const outcome = captureGitHubActivity(ledger, activity, config);
    if (outcome.captured) {
      captured++;
      if (activity.created_at > newCursor) newCursor = activity.created_at;
    } else {
      skipped++;
    }
  }
  return { captured, skipped, newCursor };
}

async function pollTerminal(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  variant: "pr_merged" | "pr_closed",
  sinceIso: string,
): Promise<{ captured: number; skipped: number; newCursor: string }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;

  const variantQ =
    variant === "pr_merged"
      ? ["is:merged", `merged:>${sinceIso}`]
      : ["is:closed", "is:unmerged", `closed:>${sinceIso}`];
  const q = [
    `author:${config.github_login}`,
    "type:pr",
    ...variantQ,
    ...orgQualifiers(config),
  ].join(" ");
  const items = await runQuery(octokit, q, "updated");

  for (const item of items) {
    const base = toBaseFields(item, /*requirePr=*/ true);
    if (!base) continue;
    // GitHub returns `merged_at` only for actually-merged PRs; for
    // closed-without-merge the cursor field is `closed_at`. Either
    // way we read the appropriate field for the cursor advance.
    const stateAt =
      variant === "pr_merged"
        ? (item.pull_request.merged_at as string | null)
        : (item.closed_at as string | null);
    // GitHub guarantees these fields are present for the matching
    // filter (is:merged -> merged_at; is:closed -> closed_at). Skip
    // anything that violates the guarantee rather than poisoning the
    // cursor.
    if (!stateAt) continue;

    const activity: PullRequestStateChangeActivity = {
      type: variant,
      ...base,
      state_at: stateAt,
    };
    const outcome = captureGitHubActivity(ledger, activity, config);
    if (outcome.captured) {
      captured++;
      if (stateAt > newCursor) newCursor = stateAt;
    } else {
      skipped++;
    }
  }
  return { captured, skipped, newCursor };
}

async function pollIssuesOpened(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  sinceIso: string,
): Promise<{ captured: number; skipped: number; newCursor: string }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;

  const q = [
    `author:${config.github_login}`,
    "type:issue",
    `created:>${sinceIso}`,
    ...orgQualifiers(config),
  ].join(" ");
  const items = await runQuery(octokit, q, "created");

  for (const item of items) {
    const base = toBaseFields(item, /*requirePr=*/ false);
    if (!base) continue;
    const activity: IssueOpenedActivity = {
      type: "issue_opened",
      ...base,
      state: item.state === "closed" ? "closed" : "open",
    };
    const outcome = captureGitHubActivity(ledger, activity, config);
    if (outcome.captured) {
      captured++;
      if (activity.created_at > newCursor) newCursor = activity.created_at;
    } else {
      skipped++;
    }
  }
  return { captured, skipped, newCursor };
}

/**
 * Comments are two-stage: search returns issues/PRs the user has
 * touched since the cursor (`commenter:X updated:>{cursor}`), then we
 * fetch the comments of each candidate via the REST issue-comments
 * endpoint and filter to ours since the same cursor.
 *
 * Search returns issues sorted by updated_at desc, which is fine -
 * we don't need order for correctness because idempotency dedupes.
 *
 * Cursor advance rules:
 *   - Successful candidate fetch with own comments captured:
 *     advance newCursor to max(comment.created_at) AND to the
 *     candidate's updated_at.
 *   - Successful candidate fetch with no own comments (e.g. only
 *     teammates were active): still advance newCursor to the
 *     candidate's updated_at. Without this, candidates that
 *     match `commenter:X` historically but only see teammate
 *     activity would be re-scanned every tick until the search
 *     hit the 1000-result cap (codex review #59 round-2).
 *   - GitHub guarantees issue.updated_at >= max(comment.created_at)
 *     for any comment on the issue, so advancing to updated_at
 *     never skips an unseen own comment.
 *   - Any candidate fetch FAILURE pins newCursor at the input
 *     value so the next tick re-processes the entire window
 *     (codex review #59 round-1).
 */
async function pollIssueComments(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  sinceIso: string,
): Promise<{ captured: number; skipped: number; newCursor: string; failures: number }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;
  let failures = 0;

  const q = [
    `commenter:${config.github_login}`,
    `updated:>${sinceIso}`,
    ...orgQualifiers(config),
  ].join(" ");
  const candidates = await runQuery(octokit, q, "updated");

  // Process candidates sequentially to keep the REST rate-limit
  // headroom predictable. For most users this loop is short.
  for (const item of candidates) {
    const base = toBaseFields(item, /*requirePr=*/ false);
    if (!base) continue;

    let comments: any[];
    try {
      comments = await octokit.paginate(
        octokit.issues.listComments,
        {
          owner: base.owner,
          repo: base.repo,
          issue_number: base.number,
          since: sinceIso,
          per_page: 100,
        },
      );
    } catch (err) {
      // 404 = repo went private / deleted; 410 = repo archived;
      // 5xx / rate-limit = transient. We skip this candidate so the
      // rest can still process, but we'll also pin the tick's cursor
      // so the next tick retries the whole window (codex review #59).
      console.error(
        `[usrcp-github] listComments(${base.owner}/${base.repo}#${base.number}) failed: ` +
        (err instanceof Error ? err.message : String(err)),
      );
      failures++;
      continue;
    }

    for (const c of comments) {
      if (!c.user || c.user.login !== config.github_login) continue;
      if (typeof c.id !== "number") continue;
      if (typeof c.body !== "string") continue;
      // GitHub's `since` is inclusive on second-precision; a comment
      // exactly at the cursor would re-arrive. Filter strictly greater
      // so the cursor advances forward; idempotency would dedupe
      // anyway but this keeps the search results clean.
      if (!(c.created_at > sinceIso)) continue;

      const activity: IssueCommentActivity = {
        type: "issue_commented",
        comment_id: c.id,
        node_id: c.node_id,
        owner: base.owner,
        repo: base.repo,
        issue_number: base.number,
        issue_title: base.title,
        is_pr_parent: !!item.pull_request,
        url: c.html_url,
        issue_url: base.url,
        body: c.body,
        author_login: c.user.login,
        created_at: c.created_at,
        updated_at: c.updated_at,
        org: base.org,
      };
      const outcome = captureGitHubActivity(ledger, activity, config);
      if (outcome.captured) {
        captured++;
        if (c.created_at > newCursor) newCursor = c.created_at;
      } else {
        skipped++;
      }
    }
    // All comments on this candidate have been inspected. Advance
    // past the candidate's updated_at so subsequent ticks don't
    // re-fetch this same window when only teammates have activity.
    // GitHub's data model guarantees updated_at >= max(comment.created_at),
    // so this never skips an unseen own comment.
    if (typeof item.updated_at === "string" && item.updated_at > newCursor) {
      newCursor = item.updated_at;
    }
  }
  // If any candidate fetch failed, pin the cursor at the input value
  // so the next tick re-processes the entire window. Successfully-
  // captured comments dedupe via idempotency keys; the failed
  // candidate's comments get another shot.
  if (failures > 0) newCursor = sinceIso;
  return { captured, skipped, newCursor, failures };
}

/**
 * PR reviews are two-stage like comments. The search index has a
 * `reviewed-by:<login>` qualifier that returns PRs the user has
 * reviewed (any review state, any time). We then fetch each
 * candidate's reviews via `pulls.listReviews` (no `since` parameter,
 * so we fetch all and filter client-side on submitted_at).
 *
 * Filter rules:
 *   - user.login === github_login (their reviews only)
 *   - submitted_at > sinceIso (strictly greater)
 *   - state in {APPROVED, CHANGES_REQUESTED, COMMENTED}
 *     (PENDING = draft not yet submitted; DISMISSED = cleared
 *      administratively, both out of scope)
 *
 * Same cursor invariants as pollIssueComments:
 *   - Pin newCursor at sinceIso if ANY candidate fetch fails.
 *   - Advance newCursor to candidate.updated_at on successful empty
 *     scans, so candidates the user reviewed historically don't
 *     get re-fetched indefinitely when only the PR author has
 *     activity. GitHub's data model guarantees
 *     `pr.updated_at >= max(review.submitted_at)`.
 */
async function pollPrReviews(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  sinceIso: string,
): Promise<{ captured: number; skipped: number; newCursor: string; failures: number }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;
  let failures = 0;

  const q = [
    `reviewed-by:${config.github_login}`,
    "type:pr",
    `updated:>${sinceIso}`,
    ...orgQualifiers(config),
  ].join(" ");
  const candidates = await runQuery(octokit, q, "updated");

  for (const item of candidates) {
    const base = toBaseFields(item, /*requirePr=*/ true);
    if (!base) continue;

    let reviews: any[];
    try {
      reviews = await octokit.paginate(
        octokit.pulls.listReviews,
        {
          owner: base.owner,
          repo: base.repo,
          pull_number: base.number,
          per_page: 100,
        },
      );
    } catch (err) {
      console.error(
        `[usrcp-github] pulls.listReviews(${base.owner}/${base.repo}#${base.number}) failed: ` +
        (err instanceof Error ? err.message : String(err)),
      );
      failures++;
      continue;
    }

    for (const r of reviews) {
      if (!r.user || r.user.login !== config.github_login) continue;
      if (typeof r.id !== "number") continue;
      if (typeof r.submitted_at !== "string") continue;
      if (r.submitted_at <= sinceIso) continue;
      // Only substantive review states. PENDING is a draft the
      // reviewer hasn't submitted yet (we'd capture it next tick
      // once submitted). DISMISSED is an administratively-cleared
      // review - the review still exists in the API but the act
      // has been undone, so we skip it.
      const state = r.state;
      if (
        state !== "APPROVED" &&
        state !== "CHANGES_REQUESTED" &&
        state !== "COMMENTED"
      ) {
        continue;
      }

      const activity: PullRequestReviewActivity = {
        type: "pr_reviewed",
        review_id: r.id,
        node_id: r.node_id,
        owner: base.owner,
        repo: base.repo,
        pr_number: base.number,
        pr_title: base.title,
        pr_author_login: base.author_login,
        state,
        body: typeof r.body === "string" ? r.body : "",
        url: r.html_url,
        pr_url: base.url,
        reviewer_login: r.user.login,
        submitted_at: r.submitted_at,
        org: base.org,
      };
      const outcome = captureGitHubActivity(ledger, activity, config);
      if (outcome.captured) {
        captured++;
        if (r.submitted_at > newCursor) newCursor = r.submitted_at;
      } else {
        skipped++;
      }
    }
    // Advance past candidate.updated_at on successful empty scans
    // (round-2 lesson from PR #59).
    if (typeof item.updated_at === "string" && item.updated_at > newCursor) {
      newCursor = item.updated_at;
    }
  }
  // Round-1 lesson from PR #59: pin on any failure.
  if (failures > 0) newCursor = sinceIso;
  return { captured, skipped, newCursor, failures };
}

export async function pollOnce(
  ledger: CaptureLedger,
  octokit: Octokit,
  config: GitHubConfig,
  cursors: CursorState,
): Promise<PollTickResult> {
  // Six independent queries run in parallel - each has its own
  // server-side cursor filter so they don't waste each other's
  // pagination budget.
  const [opened, merged, closed, issue_opened, issue_commented, pr_reviewed] = await Promise.all([
    pollOpened(ledger, octokit, config, cursors.opened),
    pollTerminal(ledger, octokit, config, "pr_merged", cursors.merged),
    pollTerminal(ledger, octokit, config, "pr_closed", cursors.closed),
    pollIssuesOpened(ledger, octokit, config, cursors.issue_opened),
    pollIssueComments(ledger, octokit, config, cursors.issue_commented),
    pollPrReviews(ledger, octokit, config, cursors.pr_reviewed),
  ]);
  return { opened, merged, closed, issue_opened, issue_commented, pr_reviewed };
}

async function main() {
  if (hasFlag("reset-config")) {
    console.error("[usrcp-github] --reset-config: launching 'usrcp setup --adapter=github'...");
    try {
      execSync("usrcp setup --adapter=github", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  // Validate config exists + is complete BEFORE constructing the
  // Ledger. `new Ledger(...)` would silently auto-initialize a
  // dev-mode ledger on a fresh install, which would poison a later
  // `usrcp setup` run (it'd skip the passphrase prompt because a
  // dev-mode ledger is already there).
  preflightConfig();
  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const masterKey = ledger.getMasterKey();
  const config = loadConfig(masterKey);
  const octokit = new Octokit({ auth: config.github_token });

  console.error(`[usrcp-github] logged in as ${config.github_login}`);
  console.error(
    `[usrcp-github] domain=${config.domain} interval=${config.poll_interval_s}s orgs=${
      config.allowlisted_orgs.length === 0 ? "(all visible)" : config.allowlisted_orgs.join(",")
    }`,
  );

  const firstRunIso = new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  const cursors: CursorState = {
    opened: config.last_synced_at ?? firstRunIso,
    merged: config.last_merged_at ?? firstRunIso,
    closed: config.last_closed_at ?? firstRunIso,
    issue_opened: config.last_issue_opened_at ?? firstRunIso,
    issue_commented: config.last_issue_commented_at ?? firstRunIso,
    pr_reviewed: config.last_pr_reviewed_at ?? firstRunIso,
  };
  console.error(
    `[usrcp-github] starting cursors: opened=${cursors.opened} merged=${cursors.merged} closed=${cursors.closed} ` +
    `issue_opened=${cursors.issue_opened} issue_commented=${cursors.issue_commented} pr_reviewed=${cursors.pr_reviewed}`,
  );

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopping) return;
    try {
      const result = await pollOnce(ledger, octokit, config, cursors);
      const advances: Partial<Record<
        "last_synced_at" | "last_merged_at" | "last_closed_at" |
        "last_issue_opened_at" | "last_issue_commented_at" |
        "last_pr_reviewed_at",
        string
      >> = {};
      if (result.opened.newCursor !== cursors.opened) {
        cursors.opened = result.opened.newCursor;
        advances.last_synced_at = cursors.opened;
      }
      if (result.merged.newCursor !== cursors.merged) {
        cursors.merged = result.merged.newCursor;
        advances.last_merged_at = cursors.merged;
      }
      if (result.closed.newCursor !== cursors.closed) {
        cursors.closed = result.closed.newCursor;
        advances.last_closed_at = cursors.closed;
      }
      if (result.issue_opened.newCursor !== cursors.issue_opened) {
        cursors.issue_opened = result.issue_opened.newCursor;
        advances.last_issue_opened_at = cursors.issue_opened;
      }
      if (result.issue_commented.newCursor !== cursors.issue_commented) {
        cursors.issue_commented = result.issue_commented.newCursor;
        advances.last_issue_commented_at = cursors.issue_commented;
      }
      if (result.pr_reviewed.newCursor !== cursors.pr_reviewed) {
        cursors.pr_reviewed = result.pr_reviewed.newCursor;
        advances.last_pr_reviewed_at = cursors.pr_reviewed;
      }
      if (Object.keys(advances).length > 0) {
        saveCursors(advances, masterKey);
      }
      const totalCaptured =
        result.opened.captured + result.merged.captured + result.closed.captured +
        result.issue_opened.captured + result.issue_commented.captured +
        result.pr_reviewed.captured;
      const totalSkipped =
        result.opened.skipped + result.merged.skipped + result.closed.skipped +
        result.issue_opened.skipped + result.issue_commented.skipped +
        result.pr_reviewed.skipped;
      const totalFailures =
        result.issue_commented.failures + result.pr_reviewed.failures;
      if (totalCaptured > 0 || totalSkipped > 0 || totalFailures > 0) {
        const ic = result.issue_commented;
        const pr = result.pr_reviewed;
        const icFailNote = ic.failures > 0 ? `,f=${ic.failures} (cursor pinned)` : "";
        const prFailNote = pr.failures > 0 ? `,f=${pr.failures} (cursor pinned)` : "";
        console.error(
          `[usrcp-github] tick: ` +
          `opened={c=${result.opened.captured},s=${result.opened.skipped}} ` +
          `merged={c=${result.merged.captured},s=${result.merged.skipped}} ` +
          `closed={c=${result.closed.captured},s=${result.closed.skipped}} ` +
          `issue_opened={c=${result.issue_opened.captured},s=${result.issue_opened.skipped}} ` +
          `issue_commented={c=${ic.captured},s=${ic.skipped}${icFailNote}} ` +
          `pr_reviewed={c=${pr.captured},s=${pr.skipped}${prFailNote}}`,
        );
      }
    } catch (err) {
      console.error(`[usrcp-github] poll error: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!stopping) {
        timer = setTimeout(() => { void tick(); }, config.poll_interval_s * 1000);
      }
    }
  };

  void tick();

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[usrcp-github] ${signal} received, shutting down.`);
    if (timer !== undefined) clearTimeout(timer);
    flushCursors();
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only run main() when invoked as a CLI - allows tests to import
// pollOnce without booting the daemon.
const invokedAsCli =
  typeof require !== "undefined" && require.main === module;
if (invokedAsCli) {
  main().catch((err: unknown) => {
    console.error("[usrcp-github] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
