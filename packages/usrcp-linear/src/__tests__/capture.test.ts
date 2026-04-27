import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { setUserSlug } from "usrcp-local/dist/encryption.js";
import {
  captureLinearActivity,
  type IssueActivity,
  type CommentActivity,
} from "../capture.js";
import type { LinearConfig } from "../config.js";

const TEAM_A_ID = "team-uuid-aaaaa";
const TEAM_A_KEY = "ENG";
const TEAM_B_ID = "team-uuid-bbbbb";
const TEAM_B_KEY = "OPS";
const TEAM_UNLISTED_ID = "team-uuid-zzzzz";

const baseConfig: LinearConfig = {
  linear_api_key: "lin_api_stub",
  allowlisted_team_ids: [TEAM_A_ID, TEAM_B_ID],
  poll_interval_s: 60,
  domain: "linear",
};

let tmpHome: string;
let origHome: string | undefined;
let ledger: Ledger;
let dbPath: string;

let issueCounter = 0;
function mkIssue(overrides: Partial<IssueActivity> = {}): IssueActivity {
  issueCounter++;
  const id = overrides.id ?? `issue-uuid-${issueCounter}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    type: "issue_created",
    id,
    identifier: `ENG-${100 + issueCounter}`,
    title: "Add OAuth login flow",
    description: "We need to support Google OAuth in the login screen.",
    url: `https://linear.app/example/issue/ENG-${100 + issueCounter}`,
    team_id: TEAM_A_ID,
    team_key: TEAM_A_KEY,
    created_at: "2026-04-27T12:00:00.000Z",
    updated_at: "2026-04-27T12:00:00.000Z",
    ...overrides,
  };
}

let commentCounter = 0;
function mkComment(overrides: Partial<CommentActivity> = {}): CommentActivity {
  commentCounter++;
  const id = overrides.id ?? `comment-uuid-${commentCounter}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    type: "comment_created",
    id,
    body: "Looking into this — will have a draft by EOD.",
    url: `https://linear.app/example/issue/ENG-100#comment-${id}`,
    issue_id: "issue-uuid-parent",
    issue_identifier: "ENG-100",
    issue_title: "Add OAuth login flow",
    team_id: TEAM_A_ID,
    team_key: TEAM_A_KEY,
    created_at: "2026-04-27T12:30:00.000Z",
    updated_at: "2026-04-27T12:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-linear-capture-"));
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

// ---------------------------------------------------------------------------
// Filter: team allowlist
// ---------------------------------------------------------------------------

describe("filter: team_not_allowlisted", () => {
  it("skips issues from teams not on the allowlist", () => {
    const issue = mkIssue({ team_id: TEAM_UNLISTED_ID });
    const result = captureLinearActivity(ledger, issue, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("team_not_allowlisted");

    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(0);
  });

  it("skips comments from teams not on the allowlist", () => {
    const comment = mkComment({ team_id: TEAM_UNLISTED_ID });
    const result = captureLinearActivity(ledger, comment, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("team_not_allowlisted");
  });

  it("captures activity from any allowlisted team", () => {
    const a = captureLinearActivity(ledger, mkIssue({ team_id: TEAM_A_ID }), baseConfig);
    const b = captureLinearActivity(ledger, mkIssue({ team_id: TEAM_B_ID, team_key: TEAM_B_KEY }), baseConfig);
    expect(a.captured).toBe(true);
    expect(b.captured).toBe(true);
    expect(ledger.getTimeline({ last_n: 10 }).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Filter: empty body
// ---------------------------------------------------------------------------

describe("filter: empty_body", () => {
  it("skips issues with whitespace-only title", () => {
    const issue = mkIssue({ title: "   " });
    const result = captureLinearActivity(ledger, issue, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_body");
  });

  it("skips comments with whitespace-only body", () => {
    const comment = mkComment({ body: "\n  \n" });
    const result = captureLinearActivity(ledger, comment, baseConfig);
    expect(result.captured).toBe(false);
    if (result.captured) throw new Error("unreachable");
    expect(result.reason).toBe("empty_body");
  });
});

// ---------------------------------------------------------------------------
// Happy path: issues
// ---------------------------------------------------------------------------

describe("capture: issue happy path", () => {
  it("writes an event with summary = '<identifier>: <title>'", () => {
    const issue = mkIssue({ identifier: "ENG-742", title: "Add OAuth login flow" });
    const result = captureLinearActivity(ledger, issue, baseConfig);
    expect(result.captured).toBe(true);

    const events = ledger.getTimeline({ last_n: 10 });
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe("ENG-742: Add OAuth login flow");
    expect(events[0].intent).toBe("issue_created");
    expect(events[0].outcome).toBe("success");
  });

  it("uses the configured domain", () => {
    const cfg: LinearConfig = { ...baseConfig, domain: "work" };
    captureLinearActivity(ledger, mkIssue(), cfg);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].domain).toBe("work");
  });

  it("uses the issue id as channel_id", () => {
    const issue = mkIssue({ id: "issue-uuid-CHANNEL-MARKER" });
    captureLinearActivity(ledger, issue, baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].channel_id).toBe("issue-uuid-CHANNEL-MARKER");
  });

  it("attaches linear / issue / team_key tags", () => {
    captureLinearActivity(ledger, mkIssue({ team_key: "ENG" }), baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].tags).toEqual(expect.arrayContaining(["linear", "issue", "ENG"]));
  });

  it("includes issue metadata in detail", () => {
    const issue = mkIssue({
      id: "issue-uuid-X",
      identifier: "ENG-555",
      description: "doc body",
      url: "https://linear.app/example/issue/ENG-555",
    });
    captureLinearActivity(ledger, issue, baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].detail).toMatchObject({
      issue_id: "issue-uuid-X",
      identifier: "ENG-555",
      description: "doc body",
      url: "https://linear.app/example/issue/ENG-555",
    });
  });

  it("truncates long titles to 200 chars with ellipsis", () => {
    const longTitle = "A".repeat(250);
    captureLinearActivity(ledger, mkIssue({ identifier: "ENG-1", title: longTitle }), baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].summary.length).toBeLessThanOrEqual(200);
    expect(events[0].summary.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path: comments
// ---------------------------------------------------------------------------

describe("capture: comment happy path", () => {
  it("uses the parent issue's id as channel_id (issue + comment thread together)", () => {
    captureLinearActivity(ledger, mkIssue({ id: "parent-1", identifier: "ENG-1" }), baseConfig);
    captureLinearActivity(ledger, mkComment({ issue_id: "parent-1", issue_identifier: "ENG-1" }), baseConfig);
    captureLinearActivity(ledger, mkComment({ issue_id: "parent-1", issue_identifier: "ENG-1" }), baseConfig);

    const grouped = ledger.getRecentEventsByChannel("parent-1", 10);
    expect(grouped.length).toBe(3);
  });

  it("summary leads with issue identifier then first body line", () => {
    const comment = mkComment({
      issue_identifier: "ENG-200",
      body: "First line, the meaty bit.\n\nSecond paragraph.",
    });
    captureLinearActivity(ledger, comment, baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].summary).toBe("ENG-200: First line, the meaty bit.");
  });

  it("stores comment.id as thread_id and parent issue.id as channel_id", () => {
    const comment = mkComment({ id: "comment-uuid-T", issue_id: "issue-uuid-P" });
    captureLinearActivity(ledger, comment, baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].channel_id).toBe("issue-uuid-P");
    expect(events[0].thread_id).toBe("comment-uuid-T");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("re-capturing the same issue ID is marked duplicate (one timeline row)", () => {
    const issue = mkIssue({ id: "stable-id-abc" });
    const first = captureLinearActivity(ledger, issue, baseConfig);
    expect(first.captured).toBe(true);
    if (!first.captured) throw new Error("unreachable");
    expect(first.duplicate).toBe(false);

    const second = captureLinearActivity(ledger, { ...issue }, baseConfig);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    expect(second.event_id).toBe(first.event_id);

    expect(ledger.getTimeline({ last_n: 100 }).length).toBe(1);
  });

  it("re-capturing the same comment ID is marked duplicate", () => {
    const comment = mkComment({ id: "stable-comment-id" });
    const first = captureLinearActivity(ledger, comment, baseConfig);
    expect(first.captured).toBe(true);
    if (!first.captured) throw new Error("unreachable");

    const second = captureLinearActivity(ledger, { ...comment }, baseConfig);
    expect(second.captured).toBe(true);
    if (!second.captured) throw new Error("unreachable");
    expect(second.duplicate).toBe(true);
    expect(second.event_id).toBe(first.event_id);
  });

  it("issue and comment with the same string ID don't collide (different namespaces)", () => {
    const sharedId = "uuid-COLLIDES";
    const issue = captureLinearActivity(ledger, mkIssue({ id: sharedId }), baseConfig);
    const comment = captureLinearActivity(ledger, mkComment({ id: sharedId }), baseConfig);
    expect(issue.captured).toBe(true);
    expect(comment.captured).toBe(true);
    if (!issue.captured || !comment.captured) throw new Error("unreachable");
    expect(comment.duplicate).toBe(false);
    expect(issue.event_id).not.toBe(comment.event_id);
  });
});

// ---------------------------------------------------------------------------
// Ciphertext at rest
// ---------------------------------------------------------------------------

describe("ciphertext at rest", () => {
  it("issue body, title, and identifier do not appear in plaintext in any column", () => {
    const markers = {
      id: "issue-uuid-DISTINCT-TURQUOISE",
      identifier: "ENG-LEAKMARKERVERMILION",
      title: "title-marker-ELEPHANT-distinctive",
      description: "description-marker-MARIGOLD-uniqueworkstring",
      url: "https://linear.app/example/url-marker-COBALT",
    };
    const issue = mkIssue(markers);
    const result = captureLinearActivity(ledger, issue, baseConfig);
    expect(result.captured).toBe(true);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare(
        `SELECT channel_id, external_user_id, summary, detail, tags, channel_hash
         FROM timeline_events`
      )
      .get() as Record<string, string | null>;
    raw.close();

    expect((row["channel_id"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["summary"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["detail"] ?? "").startsWith("enc:")).toBe(true);
    expect((row["tags"] ?? "").startsWith("enc:")).toBe(true);

    for (const col of ["channel_id", "summary", "detail", "tags"]) {
      const val = row[col];
      if (val === null) continue;
      expect(val).not.toContain(markers.id);
      expect(val).not.toContain(markers.identifier);
      expect(val).not.toContain(markers.title);
      expect(val).not.toContain(markers.description);
      expect(val).not.toContain(markers.url);
    }

    expect(row["channel_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["channel_hash"]).not.toBe(markers.id);
  });

  it("decrypted channel_id round-trips through the Ledger read path", () => {
    captureLinearActivity(ledger, mkIssue({ id: "issue-roundtrip-1" }), baseConfig);
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].channel_id).toBe("issue-roundtrip-1");
  });
});

// ---------------------------------------------------------------------------
// Restart persistence
// ---------------------------------------------------------------------------

describe("restart persistence", () => {
  it("events survive ledger close + re-open", () => {
    captureLinearActivity(ledger, mkIssue({ id: "p1", identifier: "ENG-PERSIST" }), baseConfig);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const events = reopened.getTimeline({ last_n: 10 });
      expect(events.length).toBe(1);
      expect(events[0].channel_id).toBe("p1");
      expect(events[0].summary).toContain("ENG-PERSIST");
    } finally {
      reopened.close();
      ledger = new Ledger(dbPath); // so afterEach close() doesn't double-close
    }
  });
});
