import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-core/ledger";
import { setUserSlug } from "usrcp-core/encryption";
import {
  captureCalendarActivity,
  type CalendarActivity,
} from "../capture.js";
import type { GoogleCalendarConfig } from "../config.js";

const baseConfig: GoogleCalendarConfig = {
  oauth_client_id: "stub.apps.googleusercontent.com",
  oauth_client_secret: "stub-secret",
  refresh_token: "1//stub-refresh-token",
  poll_interval_s: 300,
  domain: "calendar",
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

let eventCounter = 0;
function mkEvent(overrides: Partial<CalendarActivity> = {}): CalendarActivity {
  eventCounter++;
  const start = overrides.start ?? "2026-05-17T09:00:00Z";
  const end = overrides.end ?? "2026-05-17T10:00:00Z";
  return {
    type: "event_attended",
    id: overrides.id ?? `gcal-event-${eventCounter}-${Math.random().toString(36).slice(2, 8)}`,
    summary: "Standup with the platform team",
    description: "Daily sync. Discuss Friday's incident.",
    location: "Zoom",
    url: "https://calendar.google.com/event?eid=stub",
    start,
    end,
    organizer_email: "alice@example.com",
    attendee_emails: ["alice@example.com", "bob@example.com"],
    self_email: "alice@example.com",
    created_at: "2026-05-15T10:00:00Z",
    updated_at: "2026-05-15T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-gcal-capture-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  dbPath = path.join(tmpHome, "ledger.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// 2026-05-17T11:00:00Z is AFTER the default mkEvent end of 10:00.
const NOW = new Date("2026-05-17T11:00:00Z");

describe("happy path", () => {
  it("captures an attended event into the ledger", () => {
    const ev = mkEvent();
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(true);
    if (!result.captured) throw new Error("unreachable");
    expect(result.duplicate).toBe(false);

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(1);
    const e = timeline[0];
    expect(e.summary).toContain("Standup with the platform team");
    expect(e.intent).toBe("event_attended");
    expect(e.outcome).toBe("success");
    expect(e.domain).toBe("calendar");
    const detail = e.detail as Record<string, unknown>;
    expect(detail.event_id).toBe(ev.id);
    expect(detail.start).toBe(ev.start);
    expect(detail.end).toBe(ev.end);
    expect(detail.organizer_email).toBe("alice@example.com");
    expect(detail.attendee_emails).toEqual(["alice@example.com", "bob@example.com"]);
    expect(e.tags).toEqual(expect.arrayContaining(["google-calendar", "event"]));
  });

  it("idempotency: capturing the same event twice de-dupes via gcal:event:<id>", () => {
    const ev = mkEvent();
    const first = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(first.captured).toBe(true);

    const second = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    if (!first.captured) throw new Error("unreachable");
    expect(second.event_id).toBe(first.event_id);

    // The ledger still has only ONE entry for that calendar event.
    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(1);
  });

  it("truncates very long summaries to 200 chars (with ellipsis)", () => {
    const long = "x".repeat(500);
    const ev = mkEvent({ summary: long });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(true);
    const e = ledger.getTimeline({ last_n: 1 })[0];
    expect(e.summary.length).toBe(200);
    expect(e.summary.endsWith("…")).toBe(true);
  });
});

describe("idempotency key length", () => {
  it("handles event IDs longer than the ledger's 100-char idempotency limit", () => {
    // Google Calendar event IDs can be up to 1024 chars for imported
    // events. The capture function must hash the id so the resulting
    // idempotency key stays under the ledger's 100-char cap.
    const longId = "a".repeat(500);
    const ev = mkEvent({ id: longId });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(true);

    // Re-running with the same long id must dedupe via the SAME hashed key.
    const second = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
  });

  it("produces distinct idempotency keys for different event IDs", () => {
    const a = mkEvent({ id: "event-a" });
    const b = mkEvent({ id: "event-b" });
    const ra = captureCalendarActivity(ledger, a, baseConfig, NOW);
    const rb = captureCalendarActivity(ledger, b, baseConfig, NOW);
    expect(ra.captured).toBe(true);
    expect(rb.captured).toBe(true);
    if (!ra.captured || !rb.captured) throw new Error("unreachable");
    expect(ra.duplicate).toBe(false);
    expect(rb.duplicate).toBe(false);
    expect(ra.event_id).not.toBe(rb.event_id);
  });
});

describe("filter: future_event", () => {
  it("refuses to capture an event whose end is in the future (defense in depth)", () => {
    const ev = mkEvent({
      start: "2099-01-01T09:00:00Z",
      end: "2099-01-01T10:00:00Z",
    });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("future_event");
    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(0);
  });
});

describe("filter: no_title", () => {
  it("skips events with an empty summary", () => {
    const ev = mkEvent({ summary: "" });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_title");
    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(0);
  });

  it("skips events with a whitespace-only summary", () => {
    const ev = mkEvent({ summary: "   \t  \n" });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_title");
  });
});

describe("filter: no_id", () => {
  it("skips events with no id (defensive; reader should already filter)", () => {
    const ev = mkEvent({ id: "" });
    const result = captureCalendarActivity(ledger, ev, baseConfig, NOW);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_id");
  });
});
