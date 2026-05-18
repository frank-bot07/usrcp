# usrcp-github v1.3: PR reviews on others' PRs

Date: 2026-05-17
Branch: `feat/github-pr-reviews`
Follow-on to #57 (v1), #58 (v1.1), #59 (v1.2).

## Why

After v1.2, the GitHub adapter captures PRs you authored (open +
terminal state), issues you opened, and comments you wrote. The
remaining "what did Chad do on GitHub" signal is **reviews you
performed on others' PRs**: approves, requested-changes, and
top-level comments. After v1.3 lands, the adapter covers the
full participation surface a code-collab agent cares about.

This is the third two-stage poll flow (after issue_commented),
so it leverages every lesson learned in PR #59's two rounds of
codex review.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Which review states to capture? | APPROVED, CHANGES_REQUESTED, COMMENTED | PENDING is a draft the reviewer hasn't submitted; DISMISSED is administratively cleared. Both represent "no action took effect" and shouldn't show up in the timeline. |
| Empty review body? | Capture anyway | A plain Approve click with no message is meaningful signal (the act of approval). Skipping as `empty_body` would lose data; the state field carries the meaning. |
| `external_user_id` = reviewer or PR author? | PR author | The reviewer is always `github_login` (redundant). Using the PR author lets agents query "reviews I did for Alice" via `external_user_id`. Same idea as `external_user_id` on comments points to the issue author when relevant. |
| Distinct summary verbs per state? | Yes - "approved", "requested-changes", "reviewed" | Scannable timelines are more informative when state is at the verb level. State also lives in detail+tags so structured queries work. |
| Channel_id | `<owner>/<repo>#<pr_number>` (same as pr_opened) | Groups with the parent PR's `pr_opened`/`pr_merged`/`pr_closed`/`issue_commented` events. `getRecentEventsByChannel` returns the full PR lifecycle including your reviews on others' PRs. |
| Cursor strategy | `reviewed-by:X type:pr updated:>{cursor}` two-stage | Search index has the `reviewed-by:` qualifier. Per candidate, `pulls.listReviews` returns ALL reviews (no `since` param), so we filter client-side on `submitted_at > cursor` AND `user.login === github_login`. |
| Partial failure handling | Pin cursor at input value if ANY listReviews fails (round-1 #59 lesson) | Otherwise a transient 500 on one candidate combined with a captured review on another would advance the cursor past the failed candidate's reviews, losing them permanently. |
| Successful empty-scan advancement | Advance to `candidate.updated_at` (round-2 #59 lesson) | Without this, candidates the user reviewed historically would be re-fetched indefinitely when only the PR author has new activity. GitHub guarantees `pr.updated_at >= max(review.submitted_at)`, so this never skips an unseen own review. |
| Inline (per-diff-line) review comments? | Out of scope | Different endpoint (`pulls.listReviewComments`). Could be v1.4. The top-level review object IS captured here. |

## Surface area

**Per adapter (modified):**

- `src/config.ts`
  - Added `last_pr_reviewed_at` to `GitHubConfig`.
  - `GitHubCursorField` extended to include it.
- `src/capture.ts`
  - New `PullRequestReviewActivity` type.
  - New `captureReview` capture function (verb-per-state summary, distinct idempotency namespace, PR-author as external_user_id).
  - Dispatcher in `captureGitHubActivity` updated. Reviews use `pr_title` for the title-emptiness check; the review's own `body` may be empty (plain Approve) and should still capture.
- `src/index.ts`
  - New `pollPrReviews` function (two-stage: search + per-candidate `listReviews`).
  - `pollOnce` now runs SIX queries in parallel via `Promise.all`.
  - `main()` reads + advances + saves the new cursor.
  - Tick log line includes pr_reviewed metrics + failure indicator.
- `src/__tests__/capture.test.ts` - +9 tests for pr_reviewed (verbs per state, empty-body still captured, distinct namespace from pr_opened, allowlist gating, full body preservation, reviewer/author field separation).
- `src/__tests__/config.test.ts` - bumped to assert all 6 cursors advance.
- `src/__tests__/poll.test.ts` - +6 tests for the two-stage review fetch (happy path, foreign reviewer filter, PENDING/DISMISSED filter, strict-greater cursor, partial failure pin, candidate.updated_at advancement).
- `README.md` - cursor table extended to 6 rows; ledger-shape, rate-limit, and out-of-scope sections updated.

## Verification

- `(cd packages/usrcp-github && npm test)` -> 83/83 pass (was 68 in v1.2).
- `(cd packages/usrcp-local && npm test)` -> 422/422 (unchanged - no usrcp-local files touched).

## Out of scope (still)

- Inline review comments (different endpoint; could be v1.4).
- `pr_reopened` events (needs state tracking).
- Commits authored by you (separate REST endpoint).
- Discussions.

## What v1.0 through v1.3 covers

The full participation surface for the configured user on GitHub:

| Event              | Source       | What it means                                 |
|--------------------|--------------|-----------------------------------------------|
| `pr_opened`        | you authored | "I opened a PR"                               |
| `pr_merged`        | you authored | "my PR got merged"                            |
| `pr_closed`        | you authored | "my PR got closed without merge"              |
| `issue_opened`     | you authored | "I opened an issue"                           |
| `issue_commented`  | you authored | "I commented on someone's PR/issue"           |
| `pr_reviewed`      | you reviewed | "I reviewed someone's PR (approved/CR/comment)" |

Anything not in this list is genuinely out of scope for the GitHub adapter and would belong in a different adapter or a separate explicit follow-up PR.
