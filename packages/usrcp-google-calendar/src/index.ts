#!/usr/bin/env node
/**
 * usrcp-google-calendar: capture-only Google Calendar adapter (events
 * the configured user attended on the primary calendar).
 *
 * Webhooks would need a public URL; personal deployments run on
 * laptops behind NAT, so we poll. Google Calendar's API budget is
 * generous (default 5-minute interval is well under the per-user
 * read quota).
 *
 * Recursive setTimeout (not setInterval): a slow tick must delay the
 * next one rather than queue overlapping ticks.
 *
 * Cursor semantics: the cursor is "events whose END time is at or
 * after this ISO timestamp". We capture events that have already
 * ended, so on each tick we ask Calendar for events in
 * [last_cursor, now] and advance the cursor to max(observed_end).
 */

import { execSync } from "node:child_process";
import { calendar } from "@googleapis/calendar";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import {
  loadConfig,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GoogleCalendarConfig,
} from "./config.js";
import { captureCalendarActivity } from "./capture.js";
import { makeOAuthClient, fetchPastEvents } from "./reader.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// First-run lookback when last_synced_at is unset; gives ~24h of recent
// events on the very first poll. Beyond that the user would do a
// one-off backfill rather than expand this constant.
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function pollOnce(
  ledger: Ledger,
  api: ReturnType<typeof calendar>,
  config: GoogleCalendarConfig,
  endedAfter: Date
): Promise<{ newCursor: string; captured: number; skipped: number }> {
  const endedBefore = new Date();
  const activities = await fetchPastEvents(api, { endedAfter, endedBefore });

  let captured = 0;
  let skipped = 0;
  let newCursorMs = endedAfter.getTime();

  for (const activity of activities) {
    const outcome = captureCalendarActivity(ledger, activity, config, endedBefore);
    if (outcome.captured) {
      captured++;
      // Advance the cursor to the latest END time we've seen. Using
      // `end` (not `updated`) means we won't re-fetch already-captured
      // events on the next tick: events that have already ended cannot
      // have their end time pushed back into the [cursor, now] window
      // unless an edit moves them later, in which case re-capture
      // through the idempotency key is harmless.
      const endMs = new Date(activity.end).getTime();
      if (endMs > newCursorMs) newCursorMs = endMs;
    } else {
      skipped++;
    }
  }

  return { newCursor: new Date(newCursorMs).toISOString(), captured, skipped };
}

async function main(): Promise<void> {
  if (hasFlag("reset-config")) {
    console.error("[usrcp-google-calendar] --reset-config: launching 'usrcp setup --adapter=google-calendar'...");
    try {
      execSync("usrcp setup --adapter=google-calendar", { stdio: "inherit" });
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
  const api = calendar({ version: "v3", auth });

  // Identify the signed-in user by reading the primary calendar's id
  // (which equals the email for personal accounts).
  const cal = await api.calendars.get({ calendarId: "primary" });
  const userEmail = cal.data.id ?? "(unknown)";
  console.error(`[usrcp-google-calendar] logged in as ${userEmail} (calendar: ${cal.data.summary ?? "?"})`);
  console.error(`[usrcp-google-calendar] domain=${config.domain} interval=${config.poll_interval_s}s`);

  let cursor =
    config.last_synced_at ??
    new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  console.error(`[usrcp-google-calendar] starting cursor: ${cursor}`);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const endedAfter = new Date(cursor);
      const { newCursor, captured, skipped } = await pollOnce(ledger, api, config, endedAfter);
      if (newCursor !== cursor) {
        cursor = newCursor;
        saveLastSyncedAt(cursor);
      }
      if (captured > 0 || skipped > 0) {
        console.error(`[usrcp-google-calendar] tick: captured=${captured} skipped=${skipped} cursor=${cursor}`);
      }
    } catch (err) {
      console.error(`[usrcp-google-calendar] poll error: ${err instanceof Error ? err.message : err}`);
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
    console.error(`[usrcp-google-calendar] ${signal} received, shutting down.`);
    if (timer !== undefined) clearTimeout(timer);
    flushLastSyncedAt();
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[usrcp-google-calendar] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
