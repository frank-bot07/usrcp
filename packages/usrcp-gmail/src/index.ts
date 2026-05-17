#!/usr/bin/env node
/**
 * usrcp-gmail: capture-only Gmail adapter for messages the user SENT.
 *
 * Polling cadence is 10 min by default; Gmail's per-user budget is
 * comfortable for that. Cursor advances to max(sent_at) of captured
 * messages so the next tick fetches only newer mail. The idempotency
 * key (gmail:message:<sha256(id)[:32]>) makes re-fetching the same
 * message a no-op, so an edit that bumps internalDate (rare) doesn't
 * double-record.
 */

import { execSync } from "node:child_process";
import { gmail } from "@googleapis/gmail";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  loadConfig,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GmailConfig,
} from "./config.js";
import { captureGmailActivity } from "./capture.js";
import { makeOAuthClient, fetchSentMessages } from "./reader.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// First-run lookback when last_synced_at is unset. 24h is enough to
// catch the gap between setup and the daemon coming up without
// dumping years of history into the ledger on the first tick.
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function pollOnce(
  ledger: Ledger,
  api: ReturnType<typeof gmail>,
  config: GmailConfig,
  sentAfter: Date
): Promise<{ newCursor: string; captured: number; skipped: number }> {
  const activities = await fetchSentMessages(api, { sentAfter });
  let captured = 0;
  let skipped = 0;
  let newCursorMs = sentAfter.getTime();

  for (const activity of activities) {
    const outcome = captureGmailActivity(ledger, activity, config);
    if (outcome.captured) {
      captured++;
      const sentMs = new Date(activity.sent_at).getTime();
      if (sentMs > newCursorMs) newCursorMs = sentMs;
    } else {
      skipped++;
    }
  }

  return { newCursor: new Date(newCursorMs).toISOString(), captured, skipped };
}

async function main(): Promise<void> {
  if (hasFlag("reset-config")) {
    console.error("[usrcp-gmail] --reset-config: launching 'usrcp setup --adapter=gmail'...");
    try {
      execSync("usrcp setup --adapter=gmail", { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
    process.exit(0);
  }

  const config = loadConfig();
  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);
  const auth = makeOAuthClient({
    oauth_client_id: config.oauth_client_id,
    oauth_client_secret: config.oauth_client_secret,
    refresh_token: config.refresh_token,
  });
  const api = gmail({ version: "v1", auth });

  const profile = await api.users.getProfile({ userId: "me" });
  const userEmail = profile.data.emailAddress ?? "(unknown)";
  console.error(`[usrcp-gmail] logged in as ${userEmail} (${profile.data.messagesTotal ?? "?"} messages total)`);
  console.error(`[usrcp-gmail] domain=${config.domain} interval=${config.poll_interval_s}s`);

  let cursor =
    config.last_synced_at ??
    new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  console.error(`[usrcp-gmail] starting cursor: ${cursor}`);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const sentAfter = new Date(cursor);
      const { newCursor, captured, skipped } = await pollOnce(ledger, api, config, sentAfter);
      if (newCursor !== cursor) {
        cursor = newCursor;
        saveLastSyncedAt(cursor);
      }
      if (captured > 0 || skipped > 0) {
        console.error(`[usrcp-gmail] tick: captured=${captured} skipped=${skipped} cursor=${cursor}`);
      }
    } catch (err) {
      console.error(`[usrcp-gmail] poll error: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!stopping) {
        timer = setTimeout(() => { void tick(); }, config.poll_interval_s * 1000);
      }
    }
  };

  void tick();

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[usrcp-gmail] ${signal} received, shutting down.`);
    if (timer !== undefined) clearTimeout(timer);
    flushLastSyncedAt();
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[usrcp-gmail] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
