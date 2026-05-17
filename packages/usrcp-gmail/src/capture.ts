/**
 * captureGmailActivity is pure - takes a flattened GmailActivity so
 * tests don't need to mock the SDK. Idempotency keys hash the Gmail
 * message id under a 'gmail:message:*' namespace to stay within the
 * ledger's 100-char idempotency_key cap (Gmail message IDs are
 * typically 16 hex but can be longer for imported / forwarded mail).
 */

import * as crypto from "node:crypto";
import type { GmailConfig } from "./config.js";

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

export interface GmailActivity {
  type: "email_sent";
  /** Gmail's stable message id. */
  id: string;
  /** Gmail's threadId (= message id for single-message threads). */
  thread_id: string;
  subject: string;
  /** Plain-text body. May be very long; the ledger caps detail at 128 KiB. */
  body: string;
  /** Gmail's pre-rendered snippet (~200 chars). */
  snippet: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  /** Raw Date: header from the original message; useful for forwarded mail. */
  date_header: string | null;
  /** Gmail label ids (SENT, INBOX, custom labels, etc.) for downstream filtering. */
  label_ids: string[];
  /** ISO timestamp from message.internalDate (when Gmail received it). */
  sent_at: string;
}

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "no_id" | "no_subject_no_body";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

const SUMMARY_MAX_CHARS = 200;
// Ledger validates the serialised `detail` JSON at 64 KiB. Cap every
// field individually so a message with a long recipient list, an
// over-long subject, or a flood of labels cannot push the envelope
// over the cap and pin the cursor on a single bad message:
//   body    48 KiB  (the dominant field for normal mail)
//   subject  2 KiB
//   snippet  1 KiB
//   from    512 B
//   to/cc/bcc each 2 KiB  (room for ~25 addresses; truncates longer)
//   date_header 256 B
//   label_ids capped at 20 entries x 64 B
// Total: ~60 KiB plus JSON envelope; comfortably under 64 KiB.
const BODY_MAX_CHARS = 48 * 1024;
const SUBJECT_MAX_CHARS = 2 * 1024;
const SNIPPET_MAX_CHARS = 1024;
const FROM_MAX_CHARS = 512;
const RECIPIENT_LIST_MAX_CHARS = 2 * 1024;
const DATE_HEADER_MAX_CHARS = 256;
const LABEL_IDS_MAX = 20;
const LABEL_ID_MAX_CHARS = 64;

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function truncateBody(text: string): string {
  if (text.length <= BODY_MAX_CHARS) return text;
  return text.slice(0, BODY_MAX_CHARS - 1) + "…";
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function clampNullable(text: string | null, max: number): string | null {
  if (text === null) return null;
  return clamp(text, max);
}

function clampLabels(labels: string[]): string[] {
  return labels.slice(0, LABEL_IDS_MAX).map((l) => clamp(l, LABEL_ID_MAX_CHARS));
}

// The ledger validates the serialised detail JSON at 64 KiB. JSON
// encoding can multiply size when content has lots of newlines /
// quotes / control chars (each becomes a 2-6 char escape sequence),
// so per-character caps on individual fields are not sufficient.
// We target a slightly lower budget than the ledger's 64 KiB to leave
// headroom for the JSON envelope (keys, commas, braces) that
// JSON.stringify adds on top of the values themselves.
const SERIALISED_DETAIL_MAX_BYTES = 60 * 1024;

/**
 * Iteratively trim the `body` field of `detail` until JSON.stringify
 * fits under `cap` bytes. Returns the trimmed detail object.
 *
 * Body is the dominant contributor for any reasonable message; if
 * even an empty body can't fit (i.e. headers alone are >cap), we
 * give up and return the detail as-is - the ledger will reject it
 * and capture.ts's caller will surface the error.
 */
function fitDetailToCap(detail: Record<string, unknown>, cap: number): Record<string, unknown> {
  let serialised = JSON.stringify(detail);
  if (serialised.length <= cap) return detail;

  // Empty the body and re-measure. If headers ALONE exceed the cap,
  // the per-field clamps already failed to bound this message and
  // there's nothing left to trim.
  const probeWithoutBody = { ...detail, body: "" };
  const headersOnlyLen = JSON.stringify(probeWithoutBody).length;
  if (headersOnlyLen >= cap) return detail;

  // Bisect on the body length until the serialised form fits. Body
  // is the only field with enough mass to bisect; everything else
  // is already capped to a few KiB.
  const fullBody = String(detail.body ?? "");
  let lo = 0;
  let hi = fullBody.length;
  let best = "";
  // 30 iterations is overkill for any string up to ~1 GiB but cheap.
  for (let i = 0; i < 30 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = mid >= fullBody.length ? fullBody : fullBody.slice(0, mid) + "…";
    const probe = { ...detail, body: candidate };
    serialised = JSON.stringify(probe);
    if (serialised.length <= cap) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { ...detail, body: best };
}

/**
 * 16-byte SHA-256 prefix of the message id, hex-encoded. 32 chars +
 * the 14-char prefix = 46 chars total, well under the ledger's
 * 100-char idempotency-key cap.
 */
function messageIdempotencyKey(messageId: string): string {
  const digest = crypto.createHash("sha256").update(messageId).digest("hex");
  return `gmail:message:${digest.slice(0, 32)}`;
}

export function captureGmailActivity(
  ledger: CaptureLedger,
  activity: GmailActivity,
  config: GmailConfig
): CaptureOutcome {
  if (!activity.id) return { captured: false, reason: "no_id" };
  // An email with neither a subject nor a body has nothing useful to
  // recall later. Gmail allows it (e.g. a quick "thanks!" reply with
  // just a quoted body that got stripped); skip rather than store a
  // meaningless row.
  const hasSubject = activity.subject.trim().length > 0;
  const hasBody = activity.body.trim().length > 0;
  if (!hasSubject && !hasBody) {
    return { captured: false, reason: "no_subject_no_body" };
  }

  // Compose the summary: subject if present, else first non-empty
  // body line. Truncated to 200 chars with ellipsis.
  let summarySource = activity.subject.trim();
  if (!summarySource) {
    summarySource = activity.body.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "(no subject)";
  }
  const summary = truncateSummary(summarySource);

  const rawDetail: Record<string, unknown> = {
    message_id: activity.id,
    thread_id: activity.thread_id,
    subject: clamp(activity.subject, SUBJECT_MAX_CHARS),
    body: truncateBody(activity.body),
    snippet: clamp(activity.snippet, SNIPPET_MAX_CHARS),
    from: clamp(activity.from, FROM_MAX_CHARS),
    to: clamp(activity.to, RECIPIENT_LIST_MAX_CHARS),
    cc: clampNullable(activity.cc, RECIPIENT_LIST_MAX_CHARS),
    bcc: clampNullable(activity.bcc, RECIPIENT_LIST_MAX_CHARS),
    date_header: clampNullable(activity.date_header, DATE_HEADER_MAX_CHARS),
    label_ids: clampLabels(activity.label_ids),
    sent_at: activity.sent_at,
  };
  const detail = fitDetailToCap(rawDetail, SERIALISED_DETAIL_MAX_BYTES);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "email_sent",
      outcome: "success",
      detail,
      tags: ["gmail", "email", "sent"],
      // channel_id = thread_id so getRecentEventsByChannel returns
      // the whole thread's history (once we capture replies in a
      // future PR).
      channel_id: activity.thread_id,
      thread_id: activity.id,
    },
    "gmail",
    messageIdempotencyKey(activity.id),
    "gmail-poller"
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
