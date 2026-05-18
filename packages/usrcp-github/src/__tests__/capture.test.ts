import { describe, it, expect, beforeEach } from "vitest";
import {
  captureGitHubActivity,
  type CaptureLedger,
  type IssueCommentActivity,
  type IssueOpenedActivity,
  type PullRequestActivity,
  type PullRequestReviewActivity,
  type PullRequestStateChangeActivity,
} from "../capture.js";
import type { GitHubConfig } from "../config.js";

interface FakeEvent {
  domain: string;
  summary: string;
  intent: string;
  outcome: string;
  detail?: Record<string, unknown>;
  tags?: string[];
  channel_id?: string;
  external_user_id?: string;
  idempotencyKey?: string;
  platform: string;
}

class FakeLedger implements CaptureLedger {
  public events: FakeEvent[] = [];
  appendEvent(event: any, platform: string, idempotencyKey?: string): any {
    this.events.push({ ...event, platform, idempotencyKey });
    return {
      event_id: `evt-${this.events.length}`,
      timestamp: new Date().toISOString(),
      ledger_sequence: this.events.length,
      duplicate: false,
    };
  }
}

const CONFIG: GitHubConfig = {
  github_token: "ghp_test",
  github_login: "chad",
  allowlisted_orgs: [],
  domain: "github",
  poll_interval_s: 600,
};

function makeActivity(overrides: Partial<PullRequestActivity> = {}): PullRequestActivity {
  return {
    type: "pr_opened",
    node_id: "PR_kwDOABC123",
    number: 42,
    owner: "anthropics",
    repo: "usrcp",
    title: "Add the GitHub adapter",
    body: "v1 captures pr_opened events. Future PRs add merged/closed.",
    url: "https://github.com/anthropics/usrcp/pull/42",
    author_login: "chad",
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T10:30:00Z",
    state: "open",
    merged: false,
    org: "anthropics",
    ...overrides,
  };
}

describe("captureGitHubActivity", () => {
  let ledger: FakeLedger;

  beforeEach(() => {
    ledger = new FakeLedger();
  });

  it("captures a PR with the expected summary, idempotency key, and tags", () => {
    const result = captureGitHubActivity(ledger, makeActivity(), CONFIG);
    expect(result.captured).toBe(true);
    expect(ledger.events).toHaveLength(1);

    const e = ledger.events[0];
    expect(e.summary).toBe("anthropics/usrcp#42: Add the GitHub adapter");
    expect(e.intent).toBe("pr_opened");
    expect(e.outcome).toBe("success");
    expect(e.platform).toBe("github");
    expect(e.idempotencyKey).toBe("github:pr:anthropics/usrcp#42");
    expect(e.tags).toEqual(["github", "pull-request", "anthropics/usrcp"]);
    expect(e.channel_id).toBe("anthropics/usrcp#42");
    expect(e.external_user_id).toBe("chad");
  });

  it("truncates summary at 200 chars with an ellipsis", () => {
    const longTitle = "x".repeat(500);
    captureGitHubActivity(ledger, makeActivity({ title: longTitle }), CONFIG);
    expect(ledger.events[0].summary.length).toBe(200);
    expect(ledger.events[0].summary.endsWith("…")).toBe(true);
  });

  it("captures the full PR body in detail (not just the summary slice)", () => {
    const longBody = "Detailed PR description ".repeat(50);
    captureGitHubActivity(ledger, makeActivity({ body: longBody }), CONFIG);
    expect(ledger.events[0].detail!.body).toBe(longBody);
  });

  it("skips a PR with an empty title", () => {
    const result = captureGitHubActivity(ledger, makeActivity({ title: "" }), CONFIG);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "empty_title" });
    expect(ledger.events).toHaveLength(0);
  });

  it("skips a PR whose org is NOT in the configured allowlist", () => {
    const configWithAllowlist: GitHubConfig = {
      ...CONFIG,
      allowlisted_orgs: ["other-org", "different"],
    };
    const result = captureGitHubActivity(ledger, makeActivity(), configWithAllowlist);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "org_not_allowlisted" });
    expect(ledger.events).toHaveLength(0);
  });

  it("captures a PR whose org IS in the configured allowlist", () => {
    const configWithAllowlist: GitHubConfig = {
      ...CONFIG,
      allowlisted_orgs: ["anthropics"],
    };
    const result = captureGitHubActivity(ledger, makeActivity(), configWithAllowlist);
    expect(result.captured).toBe(true);
    expect(ledger.events).toHaveLength(1);
  });

  it("skips a user-owned PR when an allowlist is set (org === null)", () => {
    // A user's personal repo has no org. When the user opts into the
    // allowlist feature, personal repos are out of scope.
    const configWithAllowlist: GitHubConfig = {
      ...CONFIG,
      allowlisted_orgs: ["anthropics"],
    };
    const result = captureGitHubActivity(
      ledger,
      makeActivity({ owner: "chad", org: null }),
      configWithAllowlist,
    );
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "org_not_allowlisted" });
  });

  it("captures a user-owned PR (org === null) when no allowlist is set", () => {
    const result = captureGitHubActivity(
      ledger,
      makeActivity({ owner: "chad", org: null }),
      CONFIG, // allowlist is []
    );
    expect(result.captured).toBe(true);
  });

  it("records merged + state metadata for downstream consumers", () => {
    captureGitHubActivity(
      ledger,
      makeActivity({ state: "closed", merged: true }),
      CONFIG,
    );
    expect(ledger.events[0].detail!.merged).toBe(true);
    expect(ledger.events[0].detail!.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// v1.1: terminal state changes (pr_merged, pr_closed)
// ---------------------------------------------------------------------------

function makeMergedActivity(
  overrides: Partial<PullRequestStateChangeActivity> = {},
): PullRequestStateChangeActivity {
  return {
    type: "pr_merged",
    node_id: "PR_kwDOABC123",
    number: 42,
    owner: "anthropics",
    repo: "usrcp",
    title: "Add the GitHub adapter",
    url: "https://github.com/anthropics/usrcp/pull/42",
    author_login: "chad",
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T14:00:00Z",
    state_at: "2026-05-17T14:00:00Z",
    org: "anthropics",
    ...overrides,
  };
}

function makeClosedActivity(
  overrides: Partial<PullRequestStateChangeActivity> = {},
): PullRequestStateChangeActivity {
  return makeMergedActivity({ type: "pr_closed", ...overrides });
}

describe("captureGitHubActivity - pr_merged", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  it("captures with `merged:` verb in the summary and a distinct idempotency key", () => {
    const result = captureGitHubActivity(ledger, makeMergedActivity(), CONFIG);
    expect(result.captured).toBe(true);
    const e = ledger.events[0];
    expect(e.summary).toBe("anthropics/usrcp#42 merged: Add the GitHub adapter");
    expect(e.intent).toBe("pr_merged");
    expect(e.idempotencyKey).toBe("github:pr-merged:anthropics/usrcp#42");
    // Same channel_id as pr_opened so the timeline groups them.
    expect(e.channel_id).toBe("anthropics/usrcp#42");
    expect(e.tags).toEqual(["github", "pull-request", "anthropics/usrcp", "merged"]);
    expect(e.detail!.state_at).toBe("2026-05-17T14:00:00Z");
  });

  it("respects the org allowlist same as pr_opened", () => {
    const cfg: GitHubConfig = { ...CONFIG, allowlisted_orgs: ["other"] };
    const result = captureGitHubActivity(ledger, makeMergedActivity(), cfg);
    expect(result.captured).toBe(false);
    expect(ledger.events).toHaveLength(0);
  });

  it("truncates summary at 200 chars with an ellipsis", () => {
    const longTitle = "x".repeat(500);
    captureGitHubActivity(ledger, makeMergedActivity({ title: longTitle }), CONFIG);
    expect(ledger.events[0].summary.length).toBe(200);
    expect(ledger.events[0].summary.endsWith("…")).toBe(true);
  });

  it("groups with a same-PR pr_opened under the same channel_id", () => {
    // Simulating the realistic two-event sequence.
    captureGitHubActivity(ledger, makeActivity(), CONFIG);
    captureGitHubActivity(ledger, makeMergedActivity(), CONFIG);
    expect(ledger.events).toHaveLength(2);
    expect(ledger.events[0].channel_id).toBe(ledger.events[1].channel_id);
    expect(ledger.events[0].channel_id).toBe("anthropics/usrcp#42");
    // Distinct idempotency keys so they BOTH land in the ledger.
    expect(ledger.events[0].idempotencyKey).toBe("github:pr:anthropics/usrcp#42");
    expect(ledger.events[1].idempotencyKey).toBe("github:pr-merged:anthropics/usrcp#42");
  });
});

describe("captureGitHubActivity - pr_closed (without merge)", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  it("captures with `closed:` verb in the summary and a distinct idempotency key", () => {
    const result = captureGitHubActivity(ledger, makeClosedActivity(), CONFIG);
    expect(result.captured).toBe(true);
    const e = ledger.events[0];
    expect(e.summary).toBe("anthropics/usrcp#42 closed: Add the GitHub adapter");
    expect(e.intent).toBe("pr_closed");
    expect(e.idempotencyKey).toBe("github:pr-closed:anthropics/usrcp#42");
    expect(e.tags).toEqual(["github", "pull-request", "anthropics/usrcp", "closed"]);
  });

  it("uses a different idempotency key from pr_merged - so a closed-then-reopened-then-merged PR could fire both terminal events without dedup", () => {
    // (Realistically pr_closed -> reopen -> pr_merged is possible.
    // GitHub doesn't let us un-merge, so pr_merged is genuinely
    // terminal, but a PR closed without merge can later be merged.)
    captureGitHubActivity(ledger, makeClosedActivity(), CONFIG);
    captureGitHubActivity(ledger, makeMergedActivity(), CONFIG);
    const keys = ledger.events.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// v1.2: issue_opened
// ---------------------------------------------------------------------------

function makeIssueOpened(
  overrides: Partial<IssueOpenedActivity> = {},
): IssueOpenedActivity {
  return {
    type: "issue_opened",
    node_id: "I_kwDOABC456",
    number: 99,
    owner: "anthropics",
    repo: "usrcp",
    title: "Telemetry pipeline crashes on long PR titles",
    body: "Reproduction:\n1. Create a PR with a 1000-char title.\n2. Watch logs.",
    url: "https://github.com/anthropics/usrcp/issues/99",
    author_login: "chad",
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T10:00:00Z",
    state: "open",
    org: "anthropics",
    ...overrides,
  };
}

describe("captureGitHubActivity - issue_opened", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  it("captures with the same channel_id format as PRs", () => {
    const result = captureGitHubActivity(ledger, makeIssueOpened(), CONFIG);
    expect(result.captured).toBe(true);
    const e = ledger.events[0];
    expect(e.intent).toBe("issue_opened");
    expect(e.summary).toBe("anthropics/usrcp#99: Telemetry pipeline crashes on long PR titles");
    expect(e.idempotencyKey).toBe("github:issue:anthropics/usrcp#99");
    expect(e.channel_id).toBe("anthropics/usrcp#99");
    expect(e.tags).toEqual(["github", "issue", "anthropics/usrcp"]);
  });

  it("uses a distinct idempotency namespace from PRs (issue #42 vs PR #42 can never collide in GitHub but we still namespace defensively)", () => {
    // GitHub guarantees these can't collide in the same repo, but
    // the namespace is still distinct as a sanity check.
    captureGitHubActivity(ledger, makeActivity({ number: 42 }), CONFIG);
    captureGitHubActivity(ledger, makeIssueOpened({ number: 42 }), CONFIG);
    const keys = ledger.events.map((e) => e.idempotencyKey);
    expect(keys[0]).toBe("github:pr:anthropics/usrcp#42");
    expect(keys[1]).toBe("github:issue:anthropics/usrcp#42");
  });

  it("respects the org allowlist", () => {
    const cfg = { ...CONFIG, allowlisted_orgs: ["other"] };
    const result = captureGitHubActivity(ledger, makeIssueOpened(), cfg);
    expect(result.captured).toBe(false);
  });

  it("skips an issue with an empty title", () => {
    const result = captureGitHubActivity(ledger, makeIssueOpened({ title: "" }), CONFIG);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "empty_title" });
  });

  it("captures the full body in detail (not just the summary slice)", () => {
    const longBody = "Detailed issue body ".repeat(50);
    captureGitHubActivity(ledger, makeIssueOpened({ body: longBody }), CONFIG);
    expect(ledger.events[0].detail!.body).toBe(longBody);
  });
});

// ---------------------------------------------------------------------------
// v1.2: issue_commented
// ---------------------------------------------------------------------------

function makeIssueComment(
  overrides: Partial<IssueCommentActivity> = {},
): IssueCommentActivity {
  return {
    type: "issue_commented",
    comment_id: 1234567890,
    node_id: "IC_kwDOABC789",
    owner: "anthropics",
    repo: "usrcp",
    issue_number: 42,
    issue_title: "Add the GitHub adapter",
    is_pr_parent: true,
    url: "https://github.com/anthropics/usrcp/pull/42#issuecomment-1234567890",
    issue_url: "https://github.com/anthropics/usrcp/pull/42",
    body: "Looks good. One thought on the cursor strategy: maybe stash the previous tick's max for debugging?",
    author_login: "chad",
    created_at: "2026-05-17T11:00:00Z",
    updated_at: "2026-05-17T11:00:00Z",
    org: "anthropics",
    ...overrides,
  };
}

describe("captureGitHubActivity - issue_commented", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  it("captures with the comment_id as the idempotency key and parent's channel_id", () => {
    const result = captureGitHubActivity(ledger, makeIssueComment(), CONFIG);
    expect(result.captured).toBe(true);
    const e = ledger.events[0];
    expect(e.intent).toBe("issue_commented");
    expect(e.idempotencyKey).toBe("github:issue-comment:1234567890");
    expect(e.channel_id).toBe("anthropics/usrcp#42");
    // thread_id = comment ID so the timeline can dedupe at thread level.
    expect((e as any).thread_id).toBe("1234567890");
  });

  it("summary fronts with parent identifier + first 80 chars of body", () => {
    captureGitHubActivity(ledger, makeIssueComment(), CONFIG);
    const e = ledger.events[0];
    expect(e.summary.startsWith("anthropics/usrcp#42 comment: Looks good. One thought on the cursor")).toBe(true);
  });

  it("ellipsizes long comment first lines at 80 chars", () => {
    const longLine = "x".repeat(500);
    captureGitHubActivity(ledger, makeIssueComment({ body: longLine }), CONFIG);
    const e = ledger.events[0];
    // After ellipsis, the body chunk in the summary is 80 chars
    // ("comment: " + 80 = the visible portion).
    expect(e.summary).toContain("comment: " + "x".repeat(79) + "…");
  });

  it("uses the first line only (drops anything after a newline)", () => {
    captureGitHubActivity(
      ledger,
      makeIssueComment({ body: "TL;DR ship it\n\nMore detail below..." }),
      CONFIG,
    );
    expect(ledger.events[0].summary).toBe("anthropics/usrcp#42 comment: TL;DR ship it");
  });

  it("tags 'pull-request' when the parent is a PR, 'issue' otherwise", () => {
    captureGitHubActivity(ledger, makeIssueComment({ is_pr_parent: true }), CONFIG);
    captureGitHubActivity(
      ledger,
      makeIssueComment({ is_pr_parent: false, comment_id: 999 }),
      CONFIG,
    );
    expect(ledger.events[0].tags).toContain("pull-request");
    expect(ledger.events[1].tags).toContain("issue");
  });

  it("groups under the same channel_id as a pr_opened on the parent PR", () => {
    captureGitHubActivity(ledger, makeActivity({ number: 42 }), CONFIG);
    captureGitHubActivity(ledger, makeIssueComment(), CONFIG);
    expect(ledger.events[0].channel_id).toBe(ledger.events[1].channel_id);
    expect(ledger.events[0].channel_id).toBe("anthropics/usrcp#42");
  });

  it("skips a comment with empty body", () => {
    const result = captureGitHubActivity(ledger, makeIssueComment({ body: "" }), CONFIG);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "empty_body" });
  });

  it("captures the full comment body in detail (no truncation in stored detail)", () => {
    const longBody = "Detail ".repeat(200);
    captureGitHubActivity(ledger, makeIssueComment({ body: longBody }), CONFIG);
    expect(ledger.events[0].detail!.body).toBe(longBody);
  });

  it("respects the org allowlist", () => {
    const cfg = { ...CONFIG, allowlisted_orgs: ["other"] };
    const result = captureGitHubActivity(ledger, makeIssueComment(), cfg);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "org_not_allowlisted" });
  });
});

// ---------------------------------------------------------------------------
// v1.3: pr_reviewed
// ---------------------------------------------------------------------------

function makeReview(
  overrides: Partial<PullRequestReviewActivity> = {},
): PullRequestReviewActivity {
  return {
    type: "pr_reviewed",
    review_id: 9876543210,
    node_id: "PRR_kwDOABC",
    owner: "anthropics",
    repo: "claude-code",
    pr_number: 100,
    pr_title: "Add background-mode flag",
    pr_author_login: "alice",
    state: "APPROVED",
    body: "lgtm with one nit",
    url: "https://github.com/anthropics/claude-code/pull/100#pullrequestreview-9876543210",
    pr_url: "https://github.com/anthropics/claude-code/pull/100",
    reviewer_login: "chad",
    submitted_at: "2026-05-17T15:00:00Z",
    org: "anthropics",
    ...overrides,
  };
}

describe("captureGitHubActivity - pr_reviewed", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  it("uses 'approved' verb for APPROVED reviews", () => {
    const result = captureGitHubActivity(ledger, makeReview(), CONFIG);
    expect(result.captured).toBe(true);
    const e = ledger.events[0];
    expect(e.intent).toBe("pr_reviewed");
    expect(e.summary).toBe("anthropics/claude-code#100 approved: Add background-mode flag");
    expect(e.idempotencyKey).toBe("github:pr-review:9876543210");
    expect(e.channel_id).toBe("anthropics/claude-code#100");
    // external_user_id = the PR author, not the reviewer, so agents
    // can grep "reviews I did for Alice".
    expect(e.external_user_id).toBe("alice");
    expect(e.tags).toEqual(["github", "review", "approved", "anthropics/claude-code"]);
    expect((e as any).thread_id).toBe("9876543210");
  });

  it("uses 'requested-changes' verb for CHANGES_REQUESTED reviews", () => {
    captureGitHubActivity(
      ledger,
      makeReview({ state: "CHANGES_REQUESTED", review_id: 1 }),
      CONFIG,
    );
    expect(ledger.events[0].summary).toBe("anthropics/claude-code#100 requested-changes: Add background-mode flag");
    expect(ledger.events[0].tags).toContain("requested-changes");
  });

  it("uses 'reviewed' verb for COMMENTED-only reviews", () => {
    captureGitHubActivity(
      ledger,
      makeReview({ state: "COMMENTED", review_id: 2 }),
      CONFIG,
    );
    expect(ledger.events[0].summary).toBe("anthropics/claude-code#100 reviewed: Add background-mode flag");
    expect(ledger.events[0].tags).toContain("reviewed");
  });

  it("captures plain-Approve clicks (empty review body) without skipping", () => {
    // GitHub allows a reviewer to click Approve without typing a
    // body. The act of approval is the signal; an empty body should
    // NOT be treated as empty_body.
    const result = captureGitHubActivity(ledger, makeReview({ body: "" }), CONFIG);
    expect(result.captured).toBe(true);
    expect(ledger.events[0].detail!.body).toBe("");
  });

  it("uses a distinct idempotency namespace from pr_opened on the same PR", () => {
    captureGitHubActivity(ledger, makeActivity({ number: 100, owner: "anthropics", repo: "claude-code" }), CONFIG);
    captureGitHubActivity(ledger, makeReview(), CONFIG);
    expect(ledger.events).toHaveLength(2);
    const keys = ledger.events.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    // Both share the channel so getRecentEventsByChannel returns
    // them together.
    expect(ledger.events[0].channel_id).toBe(ledger.events[1].channel_id);
  });

  it("respects the org allowlist", () => {
    const cfg = { ...CONFIG, allowlisted_orgs: ["other"] };
    const result = captureGitHubActivity(ledger, makeReview(), cfg);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "org_not_allowlisted" });
  });

  it("skips a review whose parent PR title is empty (e.g. mid-rename)", () => {
    const result = captureGitHubActivity(ledger, makeReview({ pr_title: "" }), CONFIG);
    expect(result.captured).toBe(false);
    expect(result).toMatchObject({ captured: false, reason: "empty_title" });
  });

  it("preserves the full review body in detail (not just summary)", () => {
    const longBody = "Detailed review comments ".repeat(50);
    captureGitHubActivity(ledger, makeReview({ body: longBody }), CONFIG);
    expect(ledger.events[0].detail!.body).toBe(longBody);
  });

  it("captures pr_author_login and reviewer_login as distinct fields in detail", () => {
    captureGitHubActivity(ledger, makeReview(), CONFIG);
    expect(ledger.events[0].detail!.pr_author_login).toBe("alice");
    expect(ledger.events[0].detail!.reviewer_login).toBe("chad");
  });
});

// ---------------------------------------------------------------------------
// Content-filter audit (tasks/29): body fields are capped at 16KB
// before storage so a pathological PR/issue/comment/review body
// doesn't bust the ledger's 64KB detail cap and infinite-loop the
// poller's cursor.
// ---------------------------------------------------------------------------

describe("body truncation (PR #65 content audit)", () => {
  let ledger: FakeLedger;
  beforeEach(() => { ledger = new FakeLedger(); });

  function bigBody(charCount: number): string {
    return "x".repeat(charCount);
  }

  it("pr_opened body is truncated when over 16KB", () => {
    const huge = bigBody(70_000);
    captureGitHubActivity(ledger, makeActivity({ body: huge }), CONFIG);
    const stored = ledger.events[0].detail!.body as string;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toContain("[...usrcp: body truncated, original was 70000 chars]");
  });

  it("pr_opened body passes through unchanged when under 16KB", () => {
    const normal = bigBody(1_500);
    captureGitHubActivity(ledger, makeActivity({ body: normal }), CONFIG);
    expect(ledger.events[0].detail!.body).toBe(normal);
  });

  it("pr_opened body=null is preserved as null", () => {
    captureGitHubActivity(ledger, makeActivity({ body: null }), CONFIG);
    expect(ledger.events[0].detail!.body).toBeNull();
  });

  it("issue_opened body is truncated when over 16KB", () => {
    const huge = bigBody(70_000);
    captureGitHubActivity(ledger, makeIssueOpened({ body: huge }), CONFIG);
    const stored = ledger.events[0].detail!.body as string;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toContain("[...usrcp: body truncated");
  });

  it("issue_commented body is truncated when over 16KB", () => {
    const huge = bigBody(70_000);
    captureGitHubActivity(ledger, makeIssueComment({ body: huge }), CONFIG);
    const stored = ledger.events[0].detail!.body as string;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toContain("[...usrcp: body truncated");
  });

  it("pr_reviewed body is truncated when over 16KB", () => {
    const huge = bigBody(70_000);
    captureGitHubActivity(ledger, makeReview({ body: huge }), CONFIG);
    const stored = ledger.events[0].detail!.body as string;
    expect(stored.length).toBeLessThanOrEqual(16 * 1024);
    expect(stored).toContain("[...usrcp: body truncated");
  });

  it("truncated body is well-formed JSON when serialized (would have busted the 64KB ledger cap pre-fix)", () => {
    // Sanity: the post-truncation detail object should serialize
    // to well under the 64KB ledger cap. Pre-fix, a 70KB body
    // produced ~70KB of body + maybe 1KB of other fields >> 64KB.
    const huge = bigBody(70_000);
    captureGitHubActivity(ledger, makeActivity({ body: huge }), CONFIG);
    const serialized = JSON.stringify(ledger.events[0].detail);
    expect(serialized.length).toBeLessThan(64 * 1024);
  });
});
