/**
 * captureCalendarActivity is pure - takes a flattened CalendarActivity
 * (not a googleapis Calendar client) so it's trivial to test without
 * mocking the SDK. The poller in index.ts is responsible for fetching
 * + normalising events into CalendarActivity values before handing
 * them off here. Idempotency keys hash the event id under a
 * 'gcal:event:*' namespace to stay within the ledger's 100-character
 * idempotency_key limit (Google event IDs are documented up to 1024
 * chars for imported events).
 */

import * as crypto from "node:crypto";
import type { GoogleCalendarConfig } from "./config.js";

/**
 * 16-byte SHA-256 prefix of the event id, hex-encoded. 32 chars +
 * the 11-char `gcal:event:` prefix = 43 chars total, well under the
 * ledger's 100-char idempotency-key cap. 128 bits is comfortably
 * collision-resistant against any single user's calendar history.
 */
function eventIdempotencyKey(eventId: string): string {
  const digest = crypto.createHash("sha256").update(eventId).digest("hex");
  return `gcal:event:${digest.slice(0, 32)}`;
}

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

export interface CalendarActivity {
  type: "event_attended";
  /** Google Calendar's stable event ID for this specific instance. */
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  /** ISO timestamp - event start (dateTime, not date). */
  start: string;
  /** ISO timestamp - event end. */
  end: string;
  organizer_email: string | null;
  attendee_emails: string[];
  /** The signed-in user's email; used to skip declined events. */
  self_email: string;
  created_at: string;
  updated_at: string;
}

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "no_title" | "future_event" | "no_id";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

const SUMMARY_MAX_CHARS = 200;

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

export function captureCalendarActivity(
  ledger: CaptureLedger,
  activity: CalendarActivity,
  config: GoogleCalendarConfig,
  now: Date = new Date()
): CaptureOutcome {
  if (!activity.id) return { captured: false, reason: "no_id" };
  // Defense in depth: even though fetchPastEvents already filters to
  // ended events, double-check here so a future caller that bypasses
  // the filter can't dump future events into the ledger.
  if (new Date(activity.end).getTime() > now.getTime()) {
    return { captured: false, reason: "future_event" };
  }
  if (!activity.summary || activity.summary.trim().length === 0) {
    return { captured: false, reason: "no_title" };
  }

  const summary = truncateSummary(activity.summary);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "event_attended",
      outcome: "success",
      detail: {
        event_id: activity.id,
        summary: activity.summary,
        description: activity.description,
        location: activity.location,
        url: activity.url,
        start: activity.start,
        end: activity.end,
        organizer_email: activity.organizer_email,
        attendee_emails: activity.attendee_emails,
        self_email: activity.self_email,
        created_at: activity.created_at,
        updated_at: activity.updated_at,
      },
      tags: ["google-calendar", "event"],
      channel_id: activity.id,
    },
    "google-calendar",
    eventIdempotencyKey(activity.id),
    "google-calendar-poller"
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
