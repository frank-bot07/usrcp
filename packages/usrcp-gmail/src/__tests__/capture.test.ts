import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "usrcp-local/ledger";
import { setUserSlug } from "usrcp-local/encryption";
import {
  captureGmailActivity,
  type GmailActivity,
} from "../capture.js";
import type { GmailConfig } from "../config.js";

const baseConfig: GmailConfig = {
  oauth_client_id: "stub.apps.googleusercontent.com",
  oauth_client_secret: "stub-secret",
  refresh_token: "1//stub-refresh-token",
  poll_interval_s: 600,
  domain: "email",
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

let counter = 0;
function mkMsg(overrides: Partial<GmailActivity> = {}): GmailActivity {
  counter++;
  return {
    type: "email_sent",
    id: overrides.id ?? `msg-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    thread_id: "thread-abc",
    subject: "Re: project update",
    body: "Thanks - I'll review the deck tonight and send notes.",
    snippet: "Thanks - I'll review the deck...",
    from: "alice@example.com",
    to: "bob@example.com",
    cc: null,
    bcc: null,
    date_header: "Sat, 17 May 2026 10:00:00 +0000",
    label_ids: ["SENT"],
    sent_at: "2026-05-17T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-gmail-capture-"));
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

describe("happy path", () => {
  it("captures a sent message", () => {
    const msg = mkMsg();
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
    if (!result.captured) throw new Error("unreachable");
    expect(result.duplicate).toBe(false);

    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline.length).toBe(1);
    const e = timeline[0];
    expect(e.summary).toContain("Re: project update");
    expect(e.intent).toBe("email_sent");
    expect(e.outcome).toBe("success");
    expect(e.domain).toBe("email");
    const detail = e.detail as Record<string, unknown>;
    expect(detail.message_id).toBe(msg.id);
    expect(detail.thread_id).toBe("thread-abc");
    expect(detail.subject).toBe("Re: project update");
    expect(detail.body).toContain("review the deck");
    expect(detail.to).toBe("bob@example.com");
    expect(detail.label_ids).toEqual(["SENT"]);
    expect(e.tags).toEqual(expect.arrayContaining(["gmail", "email", "sent"]));
  });

  it("idempotency: same message captured twice de-dupes via gmail:message:<hash>", () => {
    const msg = mkMsg();
    const first = captureGmailActivity(ledger, msg, baseConfig);
    expect(first.captured).toBe(true);

    const second = captureGmailActivity(ledger, msg, baseConfig);
    expect(second.captured).toBe(true);
    if (!second.captured || !first.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    expect(second.event_id).toBe(first.event_id);
    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(1);
  });

  it("falls back to the first body line when subject is empty", () => {
    const msg = mkMsg({
      subject: "",
      body: "First line of body\nSecond line",
    });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
    const e = ledger.getTimeline({ last_n: 1 })[0];
    expect(e.summary).toContain("First line of body");
  });

  it("truncates long subjects to 200 chars", () => {
    const msg = mkMsg({ subject: "x".repeat(500) });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
    const e = ledger.getTimeline({ last_n: 1 })[0];
    expect(e.summary.length).toBe(200);
    expect(e.summary.endsWith("…")).toBe(true);
  });

  it("fits bodies of JSON-expanding content (newline / quote storms) under the ledger cap", () => {
    // A pathological body: 48 KiB of newlines and quotes. Each
    // newline becomes \n (2 chars) and each " becomes \" (2 chars)
    // after JSON.stringify; without the fit-to-serialised-size guard,
    // the serialised detail would balloon past 64 KiB and pin the
    // cursor. captureGmailActivity must trim the body until the
    // envelope fits.
    const pathological = ('\n"').repeat(24 * 1024); // 48 KiB body
    const msg = mkMsg({ body: pathological });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);

    const e = ledger.getTimeline({ last_n: 1 })[0];
    const detail = e.detail as Record<string, unknown>;
    expect(JSON.stringify(detail).length).toBeLessThan(64 * 1024);
    // The body still has content - the fitter trims, doesn't empty.
    expect((detail.body as string).length).toBeGreaterThan(0);
  });

  it("clamps every detail field so even an oversized message captures", () => {
    // Bulk-email worst case: huge recipient lists, a long subject,
    // many labels. With per-field clamps the serialised detail JSON
    // must stay under the ledger's 64 KiB cap.
    const hugeAddresses = Array.from({ length: 500 }, (_, i) => `recipient${i}@example.com`).join(", ");
    const msg = mkMsg({
      subject: "x".repeat(10_000),
      body: "y".repeat(60_000),
      from: "z".repeat(5_000),
      to: hugeAddresses,
      cc: hugeAddresses,
      bcc: hugeAddresses,
      date_header: "d".repeat(1_000),
      label_ids: Array.from({ length: 200 }, (_, i) => "LABEL_" + i),
      snippet: "s".repeat(5_000),
    });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);

    const e = ledger.getTimeline({ last_n: 1 })[0];
    const detail = e.detail as Record<string, unknown>;
    expect((detail.subject as string).length).toBeLessThanOrEqual(2 * 1024);
    expect((detail.body as string).length).toBeLessThanOrEqual(48 * 1024);
    expect((detail.from as string).length).toBeLessThanOrEqual(512);
    expect((detail.to as string).length).toBeLessThanOrEqual(2 * 1024);
    expect((detail.cc as string).length).toBeLessThanOrEqual(2 * 1024);
    expect((detail.bcc as string).length).toBeLessThanOrEqual(2 * 1024);
    expect((detail.snippet as string).length).toBeLessThanOrEqual(1024);
    expect((detail.date_header as string).length).toBeLessThanOrEqual(256);
    expect((detail.label_ids as string[]).length).toBeLessThanOrEqual(20);
    for (const lbl of detail.label_ids as string[]) {
      expect(lbl.length).toBeLessThanOrEqual(64);
    }
    // Total serialised size sanity check.
    expect(JSON.stringify(detail).length).toBeLessThan(64 * 1024);
  });

  it("truncates very long bodies under the ledger's 64KiB detail cap", () => {
    const msg = mkMsg({ body: "x".repeat(200 * 1024) });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
    const e = ledger.getTimeline({ last_n: 1 })[0];
    const detail = e.detail as Record<string, unknown>;
    // Body is capped at 48 KiB to leave headroom for the other fields
    // (headers, label ids, snippet, etc.) inside the 64 KiB detail JSON.
    expect((detail.body as string).length).toBeLessThanOrEqual(48 * 1024);
    expect((detail.body as string).endsWith("…")).toBe(true);
  });
});

describe("idempotency key length", () => {
  it("handles message IDs longer than the 100-char ledger limit", () => {
    // Standard Gmail ids are ~16 hex but imported/forwarded mail can
    // be much longer. Capture hashes the id so the resulting
    // idempotency key stays under the cap.
    const longId = "a".repeat(500);
    const msg = mkMsg({ id: longId });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);

    // Re-running with the same long id dedupes via the SAME hashed key.
    const second = captureGmailActivity(ledger, msg, baseConfig);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
  });

  it("distinct ids produce distinct ledger entries", () => {
    const a = mkMsg({ id: "msg-a" });
    const b = mkMsg({ id: "msg-b" });
    const ra = captureGmailActivity(ledger, a, baseConfig);
    const rb = captureGmailActivity(ledger, b, baseConfig);
    expect(ra.captured).toBe(true);
    expect(rb.captured).toBe(true);
    if (!ra.captured || !rb.captured) throw new Error("unreachable");
    expect(ra.event_id).not.toBe(rb.event_id);
    expect(ra.duplicate).toBe(false);
    expect(rb.duplicate).toBe(false);
  });
});

describe("filter: no_id", () => {
  it("refuses messages without an id", () => {
    const msg = mkMsg({ id: "" });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_id");
  });
});

describe("filter: no_subject_no_body", () => {
  it("refuses messages with empty subject AND empty body", () => {
    const msg = mkMsg({ subject: "", body: "" });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("no_subject_no_body");
  });

  it("accepts messages with only a body (no subject)", () => {
    const msg = mkMsg({ subject: "", body: "Hi!" });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
  });

  it("accepts messages with only a subject (no body)", () => {
    const msg = mkMsg({ subject: "ack", body: "" });
    const result = captureGmailActivity(ledger, msg, baseConfig);
    expect(result.captured).toBe(true);
  });
});
