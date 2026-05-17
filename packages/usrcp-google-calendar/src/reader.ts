/**
 * Google Calendar API client wrapper.
 *
 * Mints short-lived access tokens from the long-lived refresh token on
 * every poll (google-auth-library caches the access token internally
 * while it's still valid), then calls events.list on the primary
 * calendar. Returns flattened CalendarActivity records so the pure
 * capture.ts function is testable without mocking googleapis.
 */

import { OAuth2Client } from "google-auth-library";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import type { CalendarActivity } from "./capture.js";

export interface OAuthSecrets {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
}

export function makeOAuthClient(secrets: OAuthSecrets): OAuth2Client {
  const client = new OAuth2Client({
    clientId: secrets.oauth_client_id,
    clientSecret: secrets.oauth_client_secret,
  });
  client.setCredentials({ refresh_token: secrets.refresh_token });
  return client;
}

/**
 * Validate the credentials by minting an access token + fetching the
 * primary calendar metadata. Used by the setup wizard to fail fast on
 * a wrong client_id / secret / refresh_token before persisting the
 * config.
 */
export async function validateCredentials(
  secrets: OAuthSecrets
): Promise<{ ok: true; email: string; calendar_summary: string } | { ok: false; error: string }> {
  try {
    const auth = makeOAuthClient(secrets);
    const api = calendar({ version: "v3", auth });
    const cal = await api.calendars.get({ calendarId: "primary" });
    return {
      ok: true,
      email: cal.data.id ?? "(no id)",
      calendar_summary: cal.data.summary ?? "(no summary)",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FetchPastEventsOpts {
  /** ISO timestamp - lower bound for event END times. Returned events have ended after this. */
  endedAfter: Date;
  /** ISO timestamp - upper bound (defaults to now). Returned events have ended before this. */
  endedBefore: Date;
  /**
   * Max results per page. Google Calendar caps at 2500 per request; we
   * default to 250 which is plenty for a 5-minute polling cadence.
   */
  pageSize?: number;
}

/**
 * Poll the primary calendar for past events that have already ended.
 * Skips:
 *   - Cancelled events.
 *   - All-day events without explicit start/end (Google represents
 *     these with a `date` field instead of `dateTime`; we only care
 *     about timed events for "I attended X").
 *   - Events where the configured user is RSVP'd 'declined' (they
 *     didn't actually attend even if invited).
 *   - Recurring-event masters (we capture the specific instance via
 *     singleEvents=true expansion).
 */
export async function fetchPastEvents(
  api: calendar_v3.Calendar,
  opts: FetchPastEventsOpts
): Promise<CalendarActivity[]> {
  const out: CalendarActivity[] = [];
  let pageToken: string | undefined;
  const pageSize = opts.pageSize ?? 250;
  // Look up the user's email so we can detect their RSVP status on the
  // attendees array; primary calendar id == user email for personal
  // Google accounts.
  const cal = await api.calendars.get({ calendarId: "primary" });
  const userId = cal.data.id ?? "";

  do {
    const res = await api.events.list({
      calendarId: "primary",
      timeMin: opts.endedAfter.toISOString(),
      timeMax: opts.endedBefore.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: pageSize,
      pageToken,
      showDeleted: false,
    });
    for (const ev of res.data.items ?? []) {
      const activity = normaliseEvent(ev, userId);
      if (activity) out.push(activity);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return out;
}

export function normaliseEvent(
  ev: calendar_v3.Schema$Event,
  userId: string
): CalendarActivity | null {
  // Drop cancelled, all-day, and missing-timestamp events.
  if (ev.status === "cancelled") return null;
  if (!ev.id || !ev.start?.dateTime || !ev.end?.dateTime) return null;

  // Skip events the user declined. Empty attendees array means a
  // solo / personal event (user is implicitly the organiser); keep it.
  const attendees = ev.attendees ?? [];
  if (attendees.length > 0) {
    const self = attendees.find((a) => a.self === true || a.email === userId);
    if (self?.responseStatus === "declined") return null;
  }

  return {
    type: "event_attended",
    id: ev.id,
    summary: ev.summary ?? "(no title)",
    description: ev.description ?? null,
    location: ev.location ?? null,
    url: ev.htmlLink ?? null,
    start: ev.start.dateTime,
    end: ev.end.dateTime,
    organizer_email: ev.organizer?.email ?? null,
    attendee_emails: attendees.map((a) => a.email ?? "").filter((e) => e.length > 0),
    self_email: userId,
    created_at: ev.created ?? ev.start.dateTime,
    updated_at: ev.updated ?? ev.start.dateTime,
  };
}
