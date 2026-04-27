#!/usr/bin/env node
/**
 * usrcp-linear: capture-only Linear adapter (issues + comments authored by
 * the API-key viewer, filtered to allowlisted teams).
 *
 * Webhooks would need a public URL; personal deployments run on laptops
 * behind NAT, so we poll. Linear's rate limit is 1500/hr per user; two
 * paginated queries per minute is well under it.
 *
 * Recursive setTimeout (not setInterval): a slow tick must delay the next
 * one, not queue overlapping ticks.
 *
 * createdAt cursor: capture-only fires once per entity. Issue edits are
 * deferred to a future v0.5 layer of issue_updated events.
 */

import { execSync } from "node:child_process";
import { LinearClient } from "@linear/sdk";
import type { Issue, IssueConnection, CommentConnection } from "@linear/sdk";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { loadConfig, saveLastSyncedAt, flushLastSyncedAt, type LinearConfig } from "./config.js";
import { captureLinearActivity, type LinearActivity } from "./capture.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// First-run lookback when last_synced_at is unset, so activity from the
// gap between `usrcp setup` and the daemon coming up isn't lost.
const FIRST_RUN_LOOKBACK_MS = 5 * 60 * 1000;

async function fetchAllPages<T extends IssueConnection | CommentConnection>(
  conn: T,
): Promise<T> {
  while (conn.pageInfo.hasNextPage) {
    await conn.fetchNext();
  }
  return conn;
}

async function pollOnce(
  ledger: Ledger,
  linear: LinearClient,
  viewerId: string,
  config: LinearConfig,
  sinceIso: string,
): Promise<{ newCursor: string; captured: number; skipped: number }> {
  let captured = 0;
  let skipped = 0;
  let newCursor = sinceIso;

  const [issuesConn, commentsConn] = await Promise.all([
    linear.issues({
      filter: {
        createdAt: { gte: sinceIso },
        creator: { id: { eq: viewerId } },
        team: { id: { in: config.allowlisted_team_ids } },
      },
    }).then(fetchAllPages),
    linear.comments({
      filter: {
        createdAt: { gte: sinceIso },
        user: { id: { eq: viewerId } },
        // Server-side narrow to allowlisted teams so we don't drag every
        // workspace-wide comment over the wire just to drop most.
        issue: { team: { id: { in: config.allowlisted_team_ids } } },
      },
    }).then(fetchAllPages),
  ]);

  // Hydrate issue.team in parallel — SDK lazy-loads the relation.
  const issueActivities = await Promise.all(
    issuesConn.nodes.map(async (issue): Promise<LinearActivity | null> => {
      const team = await issue.team;
      if (!team) return null;
      return {
        type: "issue_created",
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        url: issue.url,
        team_id: team.id,
        team_key: team.key,
        created_at: issue.createdAt.toISOString(),
        updated_at: issue.updatedAt.toISOString(),
      };
    }),
  );

  // Hydrate comment.issue + issue.team in parallel; skip orphan comments
  // (initiative/project-update comments — out of scope for v0).
  const commentActivities = await Promise.all(
    commentsConn.nodes.map(async (comment): Promise<LinearActivity | null> => {
      const issue: Issue | undefined = await comment.issue;
      if (!issue) return null;
      const team = await issue.team;
      if (!team) return null;
      return {
        type: "comment_created",
        id: comment.id,
        body: comment.body,
        url: comment.url,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        issue_title: issue.title,
        team_id: team.id,
        team_key: team.key,
        created_at: comment.createdAt.toISOString(),
        updated_at: comment.updatedAt.toISOString(),
      };
    }),
  );

  for (const activity of [...issueActivities, ...commentActivities]) {
    if (!activity) continue;
    const outcome = captureLinearActivity(ledger, activity, config);
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
    console.error("[usrcp-linear] --reset-config: launching 'usrcp setup --adapter=linear'...");
    try {
      execSync("usrcp setup --adapter=linear", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  const config = loadConfig();
  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const linear = new LinearClient({ apiKey: config.linear_api_key });

  const me = await linear.viewer;
  console.error(`[usrcp-linear] logged in as ${me.name} <${me.email ?? "(no email)"}>`);
  console.error(`[usrcp-linear] domain=${config.domain} interval=${config.poll_interval_s}s teams=${config.allowlisted_team_ids.length}`);

  let cursor =
    config.last_synced_at ??
    new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  console.error(`[usrcp-linear] starting cursor: ${cursor}`);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopping) return;
    try {
      const { newCursor, captured, skipped } = await pollOnce(ledger, linear, me.id, config, cursor);
      if (newCursor !== cursor) {
        cursor = newCursor;
        saveLastSyncedAt(cursor);
      }
      if (captured > 0 || skipped > 0) {
        console.error(`[usrcp-linear] tick: captured=${captured} skipped=${skipped} cursor=${cursor}`);
      }
    } catch (err) {
      console.error(`[usrcp-linear] poll error: ${err instanceof Error ? err.message : err}`);
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
    console.error(`[usrcp-linear] ${signal} received, shutting down.`);
    if (timer !== undefined) clearTimeout(timer);
    flushLastSyncedAt();
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[usrcp-linear] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
