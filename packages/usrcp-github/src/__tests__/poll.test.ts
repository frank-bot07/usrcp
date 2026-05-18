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

/**
 * Build a fake Octokit whose `paginate(search.issuesAndPullRequests,
 * { q, ... })` returns the items keyed by which query qualifier the
 * `q` string contains. Each test wires the three buckets explicitly
 * so it's obvious which query gets which results.
 */
function makeFakeOctokit(items: {
  opened: any[];
  merged: any[];
  closed: any[];
}): any {
  const search = { issuesAndPullRequests: Symbol("issuesAndPullRequests") };
  const paginate = async (endpoint: unknown, params: { q: string }): Promise<any[]> => {
    expect(endpoint).toBe(search.issuesAndPullRequests);
    if (params.q.includes("is:merged")) return items.merged;
    if (params.q.includes("is:closed") && params.q.includes("is:unmerged")) {
      return items.closed;
    }
    return items.opened;
  };
  return { search, paginate };
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

    const result = await pollOnce(ledger, octokit, CONFIG, {
      opened: "2026-05-16T00:00:00Z",
      merged: "2026-05-16T00:00:00Z",
      closed: "2026-05-16T00:00:00Z",
    });

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

    const result = await pollOnce(ledger, octokit, CONFIG, {
      opened: "2026-05-16T00:00:00Z",
      merged: "2026-05-16T00:00:00Z",
      closed: "2026-05-16T00:00:00Z",
    });

    // Only the cursors with new activity advance; closed stays put.
    expect(result.opened.newCursor).toBe("2026-05-17T11:00:00Z");
    expect(result.merged.newCursor).toBe("2026-05-17T14:00:00Z");
    expect(result.closed.newCursor).toBe("2026-05-16T00:00:00Z");
  });

  it("a tick with no new activity returns the original cursors unchanged", async () => {
    const ledger = new FakeLedger();
    const octokit = makeFakeOctokit({ opened: [], merged: [], closed: [] });

    const result = await pollOnce(ledger, octokit, CONFIG, {
      opened: "2026-05-16T00:00:00Z",
      merged: "2026-05-16T00:00:00Z",
      closed: "2026-05-16T00:00:00Z",
    });

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

    const result = await pollOnce(ledger, octokit, CONFIG, {
      opened: "2026-05-16T00:00:00Z",
      merged: "2026-05-16T00:00:00Z",
      closed: "2026-05-16T00:00:00Z",
    });

    expect(result.merged.captured).toBe(0);
    expect(result.merged.newCursor).toBe("2026-05-16T00:00:00Z");
  });
});
