import { describe, it, expect, beforeEach } from "vitest";
import {
  captureGitHubActivity,
  type CaptureLedger,
  type PullRequestActivity,
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

  it("records merged + state metadata so the future v1.1 layer can use it", () => {
    captureGitHubActivity(
      ledger,
      makeActivity({ state: "closed", merged: true }),
      CONFIG,
    );
    expect(ledger.events[0].detail!.merged).toBe(true);
    expect(ledger.events[0].detail!.state).toBe("closed");
  });
});
