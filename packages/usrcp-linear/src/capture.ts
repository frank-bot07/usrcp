/**
 * captureLinearActivity is pure — takes flattened activity (not LinearClient)
 * so it's trivial to test without mocking the SDK. The poller is responsible
 * for translating SDK objects into LinearActivity. Idempotency keys use
 * separate namespaces (linear:issue:* / linear:comment:*) so an issue and
 * comment that happen to share an ID don't collide.
 */

import type { LinearConfig } from "./config.js";

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

export interface IssueActivity {
  type: "issue_created";
  /** Linear's stable UUID. Used in the idempotency key. */
  id: string;
  /** Human-readable identifier like "ENG-123". */
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team_id: string;
  team_key: string;
  created_at: string;
  updated_at: string;
}

export interface CommentActivity {
  type: "comment_created";
  /** Linear's stable comment UUID. */
  id: string;
  body: string;
  url: string;
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  team_id: string;
  team_key: string;
  created_at: string;
  updated_at: string;
}

export type LinearActivity = IssueActivity | CommentActivity;

export interface CaptureResult {
  captured: true;
  event_id: string;
  ledger_sequence: number;
  duplicate: boolean;
}

export interface CaptureSkipped {
  captured: false;
  reason: "team_not_allowlisted" | "empty_body";
}

export type CaptureOutcome = CaptureResult | CaptureSkipped;

const SUMMARY_MAX_CHARS = 200;

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

export function captureLinearActivity(
  ledger: CaptureLedger,
  activity: LinearActivity,
  config: LinearConfig,
): CaptureOutcome {
  if (!config.allowlisted_team_ids.includes(activity.team_id)) {
    return { captured: false, reason: "team_not_allowlisted" };
  }

  if (activity.type === "issue_created") {
    return captureIssue(ledger, activity, config);
  }
  return captureComment(ledger, activity, config);
}

function captureIssue(
  ledger: CaptureLedger,
  issue: IssueActivity,
  config: LinearConfig,
): CaptureOutcome {
  // Issues without a title are not possible in Linear's UI, but the API
  // permits empty strings. Skip them rather than write a meaningless event.
  if (!issue.title || issue.title.trim().length === 0) {
    return { captured: false, reason: "empty_body" };
  }

  const summary = truncateSummary(`${issue.identifier}: ${issue.title}`);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "issue_created",
      outcome: "success",
      detail: {
        issue_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        team_id: issue.team_id,
        team_key: issue.team_key,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      },
      tags: ["linear", "issue", issue.team_key],
      channel_id: issue.id,
    },
    "linear",
    `linear:issue:${issue.id}`,
    "linear-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}

function captureComment(
  ledger: CaptureLedger,
  comment: CommentActivity,
  config: LinearConfig,
): CaptureOutcome {
  if (!comment.body || comment.body.trim().length === 0) {
    return { captured: false, reason: "empty_body" };
  }

  // Comment summary fronts with the parent issue identifier so timeline
  // scans surface the work context, not the raw comment fragment.
  const firstLine = comment.body.split(/\r?\n/)[0]!.trim();
  const summary = truncateSummary(`${comment.issue_identifier}: ${firstLine}`);
  const result = ledger.appendEvent(
    {
      domain: config.domain,
      summary,
      intent: "comment_created",
      outcome: "success",
      detail: {
        comment_id: comment.id,
        body: comment.body,
        url: comment.url,
        issue_id: comment.issue_id,
        issue_identifier: comment.issue_identifier,
        issue_title: comment.issue_title,
        team_id: comment.team_id,
        team_key: comment.team_key,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
      },
      tags: ["linear", "comment", comment.team_key],
      // channel_id = parent issue ID so getRecentEventsByChannel returns
      // the issue's full activity (issue_created + all comments) together.
      channel_id: comment.issue_id,
      thread_id: comment.id,
    },
    "linear",
    `linear:comment:${comment.id}`,
    "linear-poller",
  );
  return {
    captured: true,
    event_id: result.event_id,
    ledger_sequence: result.ledger_sequence,
    duplicate: result.duplicate ?? false,
  };
}
