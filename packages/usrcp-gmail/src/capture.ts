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
// Ledger validates the serialised `detail` JSON at 64 KiB. The other
// fields (headers, label ids, snippet, dates) consume some of that
// budget; cap the body at 48 KiB to leave a comfortable margin even
// for messages with long header lists or many labels.
const BODY_MAX_CHARS = 48 * 1024;

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function truncateBody(text: string): string {
  if (text.length <= BODY_MAX_CHARS) return text;
  return text.slice(0, BODY_MAX_CHARS - 1) + "…";
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

  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "email_sent",
      outcome: "success",
      detail: {
        message_id: activity.id,
        thread_id: activity.thread_id,
        subject: activity.subject,
        body: truncateBody(activity.body),
        snippet: activity.snippet,
        from: activity.from,
        to: activity.to,
        cc: activity.cc,
        bcc: activity.bcc,
        date_header: activity.date_header,
        label_ids: activity.label_ids,
        sent_at: activity.sent_at,
      },
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
