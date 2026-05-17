import { describe, it, expect } from "vitest";
import { normaliseEvent } from "../reader.js";

const USER_ID = "alice@example.com";

function mkRawEvent(overrides: Record<string, unknown> = {}): any {
  return {
    id: "abc123",
    status: "confirmed",
    summary: "Sprint planning",
    description: "Plan the next sprint.",
    location: "Conference room A",
    htmlLink: "https://calendar.google.com/event?eid=abc123",
    start: { dateTime: "2026-05-17T09:00:00Z" },
    end: { dateTime: "2026-05-17T10:00:00Z" },
    organizer: { email: "lead@example.com" },
    attendees: [
      { email: "alice@example.com", self: true, responseStatus: "accepted" },
      { email: "bob@example.com", responseStatus: "accepted" },
    ],
    created: "2026-05-15T10:00:00Z",
    updated: "2026-05-15T10:00:00Z",
    ...overrides,
  };
}

describe("normaliseEvent", () => {
  it("flattens a happy-path event to CalendarActivity", () => {
    const out = normaliseEvent(mkRawEvent(), USER_ID);
    expect(out).not.toBeNull();
    expect(out!.type).toBe("event_attended");
    expect(out!.id).toBe("abc123");
    expect(out!.summary).toBe("Sprint planning");
    expect(out!.location).toBe("Conference room A");
    expect(out!.start).toBe("2026-05-17T09:00:00Z");
    expect(out!.end).toBe("2026-05-17T10:00:00Z");
    expect(out!.organizer_email).toBe("lead@example.com");
    expect(out!.attendee_emails).toEqual(["alice@example.com", "bob@example.com"]);
    expect(out!.self_email).toBe(USER_ID);
  });

  it("drops cancelled events", () => {
    const out = normaliseEvent(mkRawEvent({ status: "cancelled" }), USER_ID);
    expect(out).toBeNull();
  });

  it("drops all-day events (date instead of dateTime)", () => {
    const out = normaliseEvent(
      mkRawEvent({ start: { date: "2026-05-17" }, end: { date: "2026-05-18" } }),
      USER_ID
    );
    expect(out).toBeNull();
  });

  it("drops events the user declined", () => {
    const out = normaliseEvent(
      mkRawEvent({
        attendees: [
          { email: USER_ID, self: true, responseStatus: "declined" },
          { email: "bob@example.com", responseStatus: "accepted" },
        ],
      }),
      USER_ID
    );
    expect(out).toBeNull();
  });

  it("keeps events the user accepted or did not need to RSVP", () => {
    // Solo / personal events have no attendees; treat them as kept.
    const solo = normaliseEvent(mkRawEvent({ attendees: undefined }), USER_ID);
    expect(solo).not.toBeNull();

    // Accepted invite, also kept.
    const accepted = normaliseEvent(mkRawEvent(), USER_ID);
    expect(accepted).not.toBeNull();

    // Tentative is not "declined", so kept.
    const tentative = normaliseEvent(
      mkRawEvent({
        attendees: [
          { email: USER_ID, self: true, responseStatus: "tentative" },
        ],
      }),
      USER_ID
    );
    expect(tentative).not.toBeNull();
  });

  it("returns null for an event without an id", () => {
    const out = normaliseEvent(mkRawEvent({ id: undefined }), USER_ID);
    expect(out).toBeNull();
  });

  it("falls back to (no title) when summary is missing", () => {
    const out = normaliseEvent(mkRawEvent({ summary: undefined }), USER_ID);
    expect(out).not.toBeNull();
    expect(out!.summary).toBe("(no title)");
  });
});
