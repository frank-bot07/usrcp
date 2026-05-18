/**
 * Integration test for the three-query poll tick. We stub Octokit's
 * search.issuesAndPullRequests + paginate so each test controls
 * exactly what the three queries return, then assert that pollOnce
 * dispatches the right activity type to the right idempotency key.
 */

import { describe, it, expect } from "vitest";
import { pollOnce } from "../index.js";
import type { GitHubConfig } from "../config.js";
import type { CaptureLedger } from "../capture.js";

class FakeLedger implements CaptureLedger {
  public events: Array<{
    intent: string;
    channel_id?: string;
    idempotencyKey?: string;
    detail?: Record<string, unknown>;
    summary: string;
  }> = [];
  appendEvent(event: any, _platform: string, idempotencyKey?: string): any {
    this.events.push({ ...event, idempotencyKey });
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

/** A neutral starting cursor for every query type, used by most tests. */
function neutralCursors(iso = "2026-05-16T00:00:00Z") {
  return {
    opened: iso,
    merged: iso,
    closed: iso,
    issue_opened: iso,
    issue_commented: iso,
    pr_reviewed: iso,
  };
}

/**
 * Octokit-shaped search-result item. Only the fields pollOnce
 * actually reads are populated.
 */
function makeSearchItem(overrides: {
  number: number;
  owner?: string;
  repo?: string;
  state?: "open" | "closed";
  merged_at?: string | null;
  closed_at?: string | null;
  title?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
}): any {
  const owner = overrides.owner ?? "anthropics";
  const repo = overrides.repo ?? "usrcp";
  return {
    node_id: `PR_${overrides.number}`,
    number: overrides.number,
    title: overrides.title ?? `Title #${overrides.number}`,
    body: overrides.body ?? "body",
    html_url: `https://github.com/${owner}/${repo}/pull/${overrides.number}`,
    user: { login: "chad" },
    state: overrides.state ?? "open",
    closed_at: overrides.closed_at ?? null,
    created_at: overrides.created_at ?? "2026-05-17T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-05-17T10:00:00Z",
    pull_request: { merged_at: overrides.merged_at ?? null },
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  };
}

interface FakeOctokitItems {
  opened?: any[];
  merged?: any[];
  closed?: any[];
  issue_opened?: any[];
  issue_commented_candidates?: any[];
  pr_reviewed_candidates?: any[];
  /** comments-by-issue-number keyed by `${owner}/${repo}#${number}`. */
  comments?: Record<string, any[]>;
  /** reviews-by-pr-number keyed by `${owner}/${repo}#${number}`. */
  reviews?: Record<string, any[]>;
}

/**
 * Build a fake Octokit whose `paginate(search.issuesAndPullRequests,
 * { q, ... })` dispatches by qualifier, whose `paginate(
 * issues.listComments, ...)` returns comments from the per-issue map,
 * and whose `paginate(pulls.listReviews, ...)` returns reviews from
 * the per-PR map.
 *
 * Unspecified buckets default to empty arrays so tests can wire
 * only what they care about.
 */
function makeFakeOctokit(items: FakeOctokitItems): any {
  const search = { issuesAndPullRequests: Symbol("issuesAndPullRequests") };
  const listComments = Symbol("listComments");
  const listReviews = Symbol("listReviews");
  const issues = { listComments };
  const pulls = { listReviews };
  const paginate = async (
    endpoint: unknown,
    params: any,
  ): Promise<any[]> => {
    if (endpoint === search.issuesAndPullRequests) {
      const q: string = params.q;
      // Order matters: more specific qualifiers first.
      if (q.includes("reviewed-by:")) return items.pr_reviewed_candidates ?? [];
      if (q.includes("commenter:")) return items.issue_commented_candidates ?? [];
      if (q.includes("type:issue")) return items.issue_opened ?? [];
      if (q.includes("is:merged")) return items.merged ?? [];
      if (q.includes("is:closed") && q.includes("is:unmerged")) return items.closed ?? [];
      return items.opened ?? [];
    }
    if (endpoint === listComments) {
      const key = `${params.owner}/${params.repo}#${params.issue_number}`;
      return items.comments?.[key] ?? [];
    }
    if (endpoint === listReviews) {
      const key = `${params.owner}/${params.repo}#${params.pull_number}`;
      return items.reviews?.[key] ?? [];
    }
    throw new Error(`unexpected paginate endpoint`);
  };
  return { search, issues, pulls, paginate };
}

describe("pollOnce (v1.1: three queries)", () => {
  it("dispatches results from each query to the right activity type and idempotency key", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({
      opened: [makeSearchItem({ number: 1 })],
      merged: [
        makeSearchItem({
          number: 2,
          state: "closed",
          merged_at: "2026-05-17T14:00:00Z",
          updated_at: "2026-05-17T14:00:00Z",
        }),
      ],
      closed: [
        makeSearchItem({
          number: 3,
          state: "closed",
          closed_at: "2026-05-17T15:00:00Z",
          updated_at: "2026-05-17T15:00:00Z",
        }),
      ],
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.opened.captured).toBe(1);
    expect(result.merged.captured).toBe(1);
    expect(result.closed.captured).toBe(1);

    // Three events, three distinct intents + idempotency namespaces.
    expect(ledger.events).toHaveLength(3);
    const byIntent = new Map(ledger.events.map((e) => [e.intent, e]));
    expect(byIntent.get("pr_opened")!.idempotencyKey).toBe("github:pr:anthropics/usrcp#1");
    expect(byIntent.get("pr_merged")!.idempotencyKey).toBe("github:pr-merged:anthropics/usrcp#2");
    expect(byIntent.get("pr_closed")!.idempotencyKey).toBe("github:pr-closed:anthropics/usrcp#3");
  });

  it("advances each cursor independently", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({
      opened: [makeSearchItem({ number: 1, created_at: "2026-05-17T11:00:00Z" })],
      merged: [
        makeSearchItem({
          number: 2,
          state: "closed",
          merged_at: "2026-05-17T14:00:00Z",
        }),
      ],
      closed: [], // no closed-without-merge this tick
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    // Only the cursors with new activity advance; closed stays put.
    expect(result.opened.newCursor).toBe("2026-05-17T11:00:00Z");
    expect(result.merged.newCursor).toBe("2026-05-17T14:00:00Z");
    expect(result.closed.newCursor).toBe("2026-05-16T00:00:00Z");
  });

  it("a tick with no new activity returns the original cursors unchanged", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({ opened: [], merged: [], closed: [] });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.opened.newCursor).toBe("2026-05-16T00:00:00Z");
    expect(result.merged.newCursor).toBe("2026-05-16T00:00:00Z");
    expect(result.closed.newCursor).toBe("2026-05-16T00:00:00Z");
    expect(ledger.events).toHaveLength(0);
  });

  it("skips state-change items missing the matching cursor field rather than poisoning the cursor", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({
      opened: [],
      merged: [
        // GitHub guarantees merged_at on `is:merged` matches, but if
        // the response ever drops it (unexpected API drift), we must
        // skip rather than write null and advance the cursor to null.
        makeSearchItem({ number: 5, state: "closed", merged_at: null }),
      ],
      closed: [],
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.merged.captured).toBe(0);
    expect(result.merged.newCursor).toBe("2026-05-16T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// v1.2: issue_opened
// ---------------------------------------------------------------------------

/** Same shape as makeSearchItem but no pull_request field (pure issue). */
function makeIssueSearchItem(overrides: {
  number: number;
  owner?: string;
  repo?: string;
  state?: "open" | "closed";
  title?: string;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
}): any {
  const owner = overrides.owner ?? "anthropics";
  const repo = overrides.repo ?? "usrcp";
  return {
    node_id: `I_${overrides.number}`,
    number: overrides.number,
    title: overrides.title ?? `Issue #${overrides.number}`,
    body: overrides.body ?? "issue body",
    html_url: `https://github.com/${owner}/${repo}/issues/${overrides.number}`,
    user: { login: "chad" },
    state: overrides.state ?? "open",
    created_at: overrides.created_at ?? "2026-05-17T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-05-17T10:00:00Z",
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
    // No pull_request field - this is a pure issue.
  };
}

describe("pollOnce - issue_opened (v1.2)", () => {
  it("emits issue_opened with `type:issue` query and advances last_issue_opened_at", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({
      issue_opened: [
        makeIssueSearchItem({ number: 99, created_at: "2026-05-17T11:00:00Z" }),
      ],
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_opened.captured).toBe(1);
    expect(result.issue_opened.newCursor).toBe("2026-05-17T11:00:00Z");
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].intent).toBe("issue_opened");
    expect(ledger.events[0].idempotencyKey).toBe("github:issue:anthropics/usrcp#99");
  });
});

// ---------------------------------------------------------------------------
// v1.2: issue_commented (two-stage: search + listComments)
// ---------------------------------------------------------------------------

describe("pollOnce - issue_commented (v1.2)", () => {
  it("two-stage fetch: search returns candidate, listComments returns the user's comment, event emitted", async () => {
    const ledger = new FakeLedger();
    const candidate = makeIssueSearchItem({
      number: 42,
      updated_at: "2026-05-17T11:30:00Z",
    });
    // candidate has a PR shape too so we can verify is_pr_parent detection.
    candidate.pull_request = { url: "..." };
    candidate.html_url = "https://github.com/anthropics/usrcp/pull/42";
    candidate.title = "Add the GitHub adapter";

    const octokit = makeFakeOctokit({
      issue_commented_candidates: [candidate],
      comments: {
        "anthropics/usrcp#42": [
          {
            id: 1234,
            node_id: "IC_kwDOABC1",
            user: { login: "chad" },
            body: "lgtm",
            html_url: "https://github.com/anthropics/usrcp/pull/42#issuecomment-1234",
            created_at: "2026-05-17T11:30:00Z",
            updated_at: "2026-05-17T11:30:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(1);
    expect(result.issue_commented.newCursor).toBe("2026-05-17T11:30:00Z");
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].intent).toBe("issue_commented");
    expect(ledger.events[0].idempotencyKey).toBe("github:issue-comment:1234");
    // PR-parent flag flows through to the event detail.
    expect(ledger.events[0].detail!.is_pr_parent).toBe(true);
  });

  it("filters out comments authored by other users", async () => {
    const ledger = new FakeLedger();
    const candidate = makeIssueSearchItem({
      number: 7,
      updated_at: "2026-05-17T12:00:00Z",
    });
    const octokit = makeFakeOctokit({
      issue_commented_candidates: [candidate],
      comments: {
        "anthropics/usrcp#7": [
          {
            id: 100,
            user: { login: "someone-else" },
            body: "comment from a teammate",
            html_url: "https://github.com/anthropics/usrcp/issues/7#issuecomment-100",
            created_at: "2026-05-17T11:50:00Z",
            updated_at: "2026-05-17T11:50:00Z",
            node_id: "IC_x",
          },
          {
            id: 101,
            user: { login: "chad" },
            body: "my reply",
            html_url: "https://github.com/anthropics/usrcp/issues/7#issuecomment-101",
            created_at: "2026-05-17T11:55:00Z",
            updated_at: "2026-05-17T11:55:00Z",
            node_id: "IC_y",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(1);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:issue-comment:101");
  });

  it("filters out comments at-or-before the cursor (only strictly newer fire)", async () => {
    // The REST `since` is inclusive on seconds; we filter strictly
    // greater than the cursor to avoid replaying the boundary.
    const ledger = new FakeLedger();
    const candidate = makeIssueSearchItem({
      number: 7,
      updated_at: "2026-05-17T12:00:00Z",
    });
    const octokit = makeFakeOctokit({
      issue_commented_candidates: [candidate],
      comments: {
        "anthropics/usrcp#7": [
          {
            id: 200,
            user: { login: "chad" },
            body: "exactly at cursor",
            html_url: "",
            created_at: "2026-05-16T00:00:00Z",
            updated_at: "2026-05-16T00:00:00Z",
            node_id: "IC_z",
          },
          {
            id: 201,
            user: { login: "chad" },
            body: "after cursor",
            html_url: "",
            created_at: "2026-05-17T10:00:00Z",
            updated_at: "2026-05-17T10:00:00Z",
            node_id: "IC_w",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(1);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:issue-comment:201");
  });

  it("a listComments error on one candidate doesn't kill the whole tick", async () => {
    const ledger = new FakeLedger();
    const candidates = [
      makeIssueSearchItem({ number: 1, updated_at: "2026-05-17T11:00:00Z" }),
      makeIssueSearchItem({ number: 2, updated_at: "2026-05-17T11:00:00Z" }),
    ];
    // Custom paginate that throws on #1, returns one comment for #2.
    const search = { issuesAndPullRequests: Symbol("s") };
    const listComments = Symbol("lc");
    const octokit = {
      search,
      issues: { listComments },
      paginate: async (endpoint: unknown, params: any) => {
        if (endpoint === search.issuesAndPullRequests) {
          return params.q.includes("commenter:") ? candidates : [];
        }
        if (endpoint === listComments) {
          if (params.issue_number === 1) throw new Error("simulated 404");
          return [
            {
              id: 500,
              user: { login: "chad" },
              body: "from #2",
              html_url: "",
              created_at: "2026-05-17T11:00:00Z",
              updated_at: "2026-05-17T11:00:00Z",
              node_id: "IC_a",
            },
          ];
        }
        throw new Error("unexpected");
      },
    };

    const result = await pollOnce(ledger, octokit as any, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(1);
    expect(result.issue_commented.failures).toBe(1);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:issue-comment:500");
  });

  it("partial failure pins the cursor at the input value (codex PR #59 review)", async () => {
    // Two candidates, both with new comments by the user. listComments
    // succeeds for #2 but fails for #1. Without the pin, the cursor
    // would advance past #2's comment time, and on the next tick
    // listComments(#1, since=newCursor) would skip #1's earlier
    // comment forever.
    const ledger = new FakeLedger();
    const candidates = [
      makeIssueSearchItem({ number: 1, updated_at: "2026-05-17T11:00:00Z" }),
      makeIssueSearchItem({ number: 2, updated_at: "2026-05-17T12:00:00Z" }),
    ];
    const search = { issuesAndPullRequests: Symbol("s") };
    const listComments = Symbol("lc");
    const octokit = {
      search,
      issues: { listComments },
      paginate: async (endpoint: unknown, params: any) => {
        if (endpoint === search.issuesAndPullRequests) {
          return params.q.includes("commenter:") ? candidates : [];
        }
        if (endpoint === listComments) {
          if (params.issue_number === 1) throw new Error("simulated 500");
          return [
            {
              id: 700,
              user: { login: "chad" },
              body: "from #2, post-cursor",
              html_url: "",
              created_at: "2026-05-17T11:30:00Z",
              updated_at: "2026-05-17T11:30:00Z",
              node_id: "IC_q",
            },
          ];
        }
        throw new Error("unexpected");
      },
    };

    const cursors = neutralCursors(); // "2026-05-16T00:00:00Z"
    const result = await pollOnce(ledger, octokit as any, CONFIG, cursors);

    // #2's comment was captured for completeness this tick.
    expect(result.issue_commented.captured).toBe(1);
    expect(result.issue_commented.failures).toBe(1);
    // CRITICAL: the cursor MUST NOT advance, so the next tick retries
    // the entire window and can re-fetch #1's comments.
    expect(result.issue_commented.newCursor).toBe(cursors.issue_commented);
  });

  it("advances cursor to candidate.updated_at even when no own comments emit (codex PR #59 round-2)", async () => {
    // Scenario: candidate appears in `commenter:X` search because the
    // user has historically commented, but only teammates have been
    // active since the cursor. listComments succeeds with zero
    // own-author matches. Without advancing the cursor past the
    // candidate's updated_at, the same candidate would be re-fetched
    // every tick indefinitely (growing the candidate set, wasting
    // REST quota, eventually hitting the search 1000-result cap).
    const ledger = new FakeLedger();
    const candidate = makeIssueSearchItem({
      number: 5,
      updated_at: "2026-05-17T12:00:00Z",
    });
    const octokit = makeFakeOctokit({
      issue_commented_candidates: [candidate],
      comments: {
        "anthropics/usrcp#5": [
          {
            id: 700,
            user: { login: "someone-else" },
            body: "from someone else",
            html_url: "",
            created_at: "2026-05-17T11:00:00Z",
            updated_at: "2026-05-17T11:00:00Z",
            node_id: "IC_b",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(0);
    expect(result.issue_commented.failures).toBe(0);
    // Cursor MUST advance past the candidate's updated_at.
    expect(result.issue_commented.newCursor).toBe("2026-05-17T12:00:00Z");
  });

  it("on a tick with a mix of candidates, cursor ends at max(candidate.updated_at, emitted comment.created_at)", async () => {
    const ledger = new FakeLedger();
    const candidates = [
      // Candidate with our comment.
      makeIssueSearchItem({ number: 1, updated_at: "2026-05-17T13:00:00Z" }),
      // Candidate with only teammate activity, but UPDATED_AT IS LATER.
      makeIssueSearchItem({ number: 2, updated_at: "2026-05-17T14:00:00Z" }),
    ];
    const octokit = makeFakeOctokit({
      issue_commented_candidates: candidates,
      comments: {
        "anthropics/usrcp#1": [
          {
            id: 800,
            user: { login: "chad" },
            body: "my comment",
            html_url: "",
            created_at: "2026-05-17T12:30:00Z",
            updated_at: "2026-05-17T12:30:00Z",
            node_id: "IC_c",
          },
        ],
        "anthropics/usrcp#2": [
          {
            id: 801,
            user: { login: "someone-else" },
            body: "teammate",
            html_url: "",
            created_at: "2026-05-17T14:00:00Z",
            updated_at: "2026-05-17T14:00:00Z",
            node_id: "IC_d",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.issue_commented.captured).toBe(1);
    expect(result.issue_commented.newCursor).toBe("2026-05-17T14:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// v1.3: pr_reviewed (two-stage: search + listReviews)
// ---------------------------------------------------------------------------

/** PR-shaped search item (has pull_request field). Different author than us. */
function makeReviewCandidate(overrides: {
  number: number;
  owner?: string;
  repo?: string;
  author?: string;
  updated_at?: string;
  title?: string;
}): any {
  const owner = overrides.owner ?? "anthropics";
  const repo = overrides.repo ?? "claude-code";
  return {
    node_id: `PR_${overrides.number}`,
    number: overrides.number,
    title: overrides.title ?? `PR #${overrides.number}`,
    body: "body",
    html_url: `https://github.com/${owner}/${repo}/pull/${overrides.number}`,
    user: { login: overrides.author ?? "alice" },
    state: "open",
    closed_at: null,
    created_at: "2026-05-17T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-05-17T15:00:00Z",
    pull_request: { merged_at: null },
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
  };
}

describe("pollOnce - pr_reviewed (v1.3)", () => {
  it("two-stage fetch: search returns reviewed PR, listReviews returns user's APPROVED review, event emitted", async () => {
    const ledger = new FakeLedger();
    const candidate = makeReviewCandidate({ number: 100, updated_at: "2026-05-17T15:00:00Z" });
    const octokit = makeFakeOctokit({
      pr_reviewed_candidates: [candidate],
      reviews: {
        "anthropics/claude-code#100": [
          {
            id: 5000,
            node_id: "PRR_5000",
            user: { login: "chad" },
            state: "APPROVED",
            body: "lgtm",
            html_url: "https://github.com/anthropics/claude-code/pull/100#pullrequestreview-5000",
            submitted_at: "2026-05-17T14:55:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.pr_reviewed.captured).toBe(1);
    expect(result.pr_reviewed.failures).toBe(0);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0].intent).toBe("pr_reviewed");
    expect(ledger.events[0].idempotencyKey).toBe("github:pr-review:5000");
    expect(ledger.events[0].detail!.state).toBe("APPROVED");
    expect(ledger.events[0].detail!.pr_author_login).toBe("alice");
  });

  it("filters out reviews by other users", async () => {
    const ledger = new FakeLedger();
    const candidate = makeReviewCandidate({ number: 100 });
    const octokit = makeFakeOctokit({
      pr_reviewed_candidates: [candidate],
      reviews: {
        "anthropics/claude-code#100": [
          {
            id: 5001,
            node_id: "PRR_5001",
            user: { login: "someone-else" },
            state: "APPROVED",
            body: "",
            html_url: "",
            submitted_at: "2026-05-17T14:55:00Z",
          },
          {
            id: 5002,
            node_id: "PRR_5002",
            user: { login: "chad" },
            state: "COMMENTED",
            body: "ack",
            html_url: "",
            submitted_at: "2026-05-17T14:56:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.pr_reviewed.captured).toBe(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:pr-review:5002");
  });

  it("skips PENDING (draft) and DISMISSED reviews", async () => {
    const ledger = new FakeLedger();
    const candidate = makeReviewCandidate({ number: 100 });
    const octokit = makeFakeOctokit({
      pr_reviewed_candidates: [candidate],
      reviews: {
        "anthropics/claude-code#100": [
          {
            id: 6000,
            node_id: "PRR_6000",
            user: { login: "chad" },
            state: "PENDING",
            body: "draft",
            html_url: "",
            submitted_at: "2026-05-17T14:55:00Z",
          },
          {
            id: 6001,
            node_id: "PRR_6001",
            user: { login: "chad" },
            state: "DISMISSED",
            body: "cleared",
            html_url: "",
            submitted_at: "2026-05-17T14:56:00Z",
          },
          {
            id: 6002,
            node_id: "PRR_6002",
            user: { login: "chad" },
            state: "CHANGES_REQUESTED",
            body: "fix this",
            html_url: "",
            submitted_at: "2026-05-17T14:57:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.pr_reviewed.captured).toBe(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:pr-review:6002");
    expect(ledger.events[0].detail!.state).toBe("CHANGES_REQUESTED");
  });

  it("filters out reviews at-or-before the cursor (strictly newer fire)", async () => {
    const ledger = new FakeLedger();
    const candidate = makeReviewCandidate({ number: 100 });
    const octokit = makeFakeOctokit({
      pr_reviewed_candidates: [candidate],
      reviews: {
        "anthropics/claude-code#100": [
          {
            id: 7000,
            user: { login: "chad" },
            state: "APPROVED",
            body: "old",
            html_url: "",
            node_id: "x",
            submitted_at: "2026-05-16T00:00:00Z", // exactly at cursor
          },
          {
            id: 7001,
            user: { login: "chad" },
            state: "APPROVED",
            body: "fresh",
            html_url: "",
            node_id: "y",
            submitted_at: "2026-05-17T10:00:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.pr_reviewed.captured).toBe(1);
    expect(ledger.events[0].idempotencyKey).toBe("github:pr-review:7001");
  });

  it("partial failure pins the cursor (round-1 lesson from PR #59)", async () => {
    const ledger = new FakeLedger();
    const candidates = [
      makeReviewCandidate({ number: 1, updated_at: "2026-05-17T11:00:00Z" }),
      makeReviewCandidate({ number: 2, updated_at: "2026-05-17T12:00:00Z" }),
    ];
    const search = { issuesAndPullRequests: Symbol("s") };
    const listReviews = Symbol("lr");
    const octokit = {
      search,
      pulls: { listReviews },
      paginate: async (endpoint: unknown, params: any) => {
        if (endpoint === search.issuesAndPullRequests) {
          return params.q.includes("reviewed-by:") ? candidates : [];
        }
        if (endpoint === listReviews) {
          if (params.pull_number === 1) throw new Error("simulated 500");
          return [
            {
              id: 8000,
              user: { login: "chad" },
              state: "APPROVED",
              body: "",
              html_url: "",
              node_id: "z",
              submitted_at: "2026-05-17T11:30:00Z",
            },
          ];
        }
        throw new Error("unexpected");
      },
    };

    const cursors = neutralCursors();
    const result = await pollOnce(ledger, octokit as any, CONFIG, cursors);

    // #2's review was captured this tick.
    expect(result.pr_reviewed.captured).toBe(1);
    expect(result.pr_reviewed.failures).toBe(1);
    // Cursor MUST pin so #1 gets retried.
    expect(result.pr_reviewed.newCursor).toBe(cursors.pr_reviewed);
  });

  it("advances cursor to candidate.updated_at on successful empty scans (round-2 lesson from PR #59)", async () => {
    const ledger = new FakeLedger();
    const candidate = makeReviewCandidate({
      number: 200,
      updated_at: "2026-05-17T18:00:00Z",
    });
    const octokit = makeFakeOctokit({
      pr_reviewed_candidates: [candidate],
      reviews: {
        // Only someone else's review since the cursor; our own is
        // historical.
        "anthropics/claude-code#200": [
          {
            id: 9000,
            user: { login: "someone-else" },
            state: "APPROVED",
            body: "",
            html_url: "",
            node_id: "x",
            submitted_at: "2026-05-17T17:00:00Z",
          },
        ],
      },
    });

    const result = await pollOnce(ledger, octokit, CONFIG, neutralCursors());

    expect(result.pr_reviewed.captured).toBe(0);
    expect(result.pr_reviewed.failures).toBe(0);
    // Cursor advances past candidate.updated_at so this candidate
    // doesn't get re-fetched indefinitely.
    expect(result.pr_reviewed.newCursor).toBe("2026-05-17T18:00:00Z");
  });
});
