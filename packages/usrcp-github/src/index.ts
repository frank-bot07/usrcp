#!/usr/bin/env node
/**
 * usrcp-github: capture-only adapter for PRs authored by the configured
 * user, filtered to optional allowlisted orgs.
 *
 * Polls the GitHub REST search API (issuesAndPullRequests) with
 * `author:<login> type:pr created:><cursor>`. Search is rate-limited
 * to 30 req/min for authenticated users; polling at 600s with one
 * paginated query per tick is well under the cap.
 *
 * Recursive setTimeout (not setInterval): a slow tick must delay the
 * next one, not queue overlapping ticks.
 *
 * created cursor: capture-only fires once per PR. State changes
 * (merged, closed, reviewed) come in a future v1.1.
 */

import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  loadConfig,
  preflightConfig,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GitHubConfig,
} from "./config.js";
import { captureGitHubActivity, type PullRequestActivity } from "./capture.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// First-run lookback when last_synced_at is unset, so activity from
// the gap between `usrcp setup` and the daemon coming up isn't lost.
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

interface PollResult {
  newCursor: string;
  captured: number;
  skipped: number;
}

export async function pollOnce(
  ledger: { appendEvent: Parameters<typeof captureGitHubActivity>[0]["appendEvent"] },
  octokit: Octokit,
  config: GitHubConfig,
  sinceIso: string,
): Promise<PollResult> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;

  // GitHub's search query syntax: scope by author + type + created
  // window, plus optional org allowlist (server-side filter).
  const qParts = [
    `author:${config.github_login}`,
    "type:pr",
    `created:>${sinceIso}`,
  ];
  if (config.allowlisted_orgs.length > 0) {
    for (const org of config.allowlisted_orgs) {
      qParts.push(`org:${org}`);
    }
  }
  const q = qParts.join(" ");

  const items = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q,
    sort: "created",
    order: "asc",
    per_page: 100,
  });

  for (const item of items) {
    if (!item.pull_request) continue;
    const parsed = parseRepoUrl(item.repository_url);
    if (!parsed) continue;
    if (!item.user) continue;

    // Search API returns the issue-shaped view of a PR. `pull_request.merged_at`
    // is present iff the PR has been merged. `repository_url` is the only
    // hint at the owning org, and GitHub doesn't return an explicit
    // org-vs-user flag - we treat any owner login as the org slug for
    // allowlist purposes. captureGitHubActivity re-checks.
    const activity: PullRequestActivity = {
      type: "pr_opened",
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
      state: item.state === "closed" ? "closed" : "open",
      merged: !!item.pull_request.merged_at,
      org: parsed.owner,
    };

    const outcome = captureGitHubActivity(ledger, activity, config);
    if (outcome.captured) {
      captured++;
      if (activity.created_at > newCursor) newCursor = activity.created_at;
    } else {
      skipped++;
    }
  }

  return { newCursor, captured, skipped };
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

  let cursor =
    config.last_synced_at ??
    new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  console.error(`[usrcp-github] starting cursor: ${cursor}`);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopping) return;
    try {
      const { newCursor, captured, skipped } = await pollOnce(ledger, octokit, config, cursor);
      if (newCursor !== cursor) {
        cursor = newCursor;
        saveLastSyncedAt(cursor, masterKey);
      }
      if (captured > 0 || skipped > 0) {
        console.error(`[usrcp-github] tick: captured=${captured} skipped=${skipped} cursor=${cursor}`);
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
    flushLastSyncedAt();
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
