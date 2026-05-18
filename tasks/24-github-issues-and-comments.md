# usrcp-github v1.2: issues + issue comments

Date: 2026-05-17
Branch: `feat/github-issues-and-comments`
Follow-on to #57 (v1) and #58 (v1.1).

## Why

After v1.1, the GitHub adapter captures PR open + terminal state.
The missing pieces for "what did Chad do on GitHub this week":

- Issues you opened (bug reports, feature requests, RFCs).
- Comments you authored on issues *or* PRs (where most of the
  back-and-forth happens).

This PR closes both gaps. After it lands, an agent can reconstruct
your GitHub participation from the ledger without re-querying GitHub.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Combine `issue_opened` and `issue_commented` in one PR? | Yes | They share scaffolding (cursors, capture dispatcher, allowlist gate). Splitting would duplicate work. |
| Cursor for `issue_commented`? | `commenter:X updated:>{cursor}` two-stage | The search index doesn't surface individual comments, only the issues/PRs they're on. We get candidates from search, then fetch comments with `since={cursor}` and filter to ours. |
| Comment idempotency key? | `github:issue-comment:<comment_id>` | GitHub comment IDs are stable, globally unique integers. Search may surface the same parent issue across ticks; idempotency dedupes at the comment level. |
| Should `issue_commented` on a PR share channel_id with the PR? | Yes - `<owner>/<repo>#<number>` for both | GitHub uses one numbering namespace per repo. PR #42 and issue #42 can't coexist in the same repo. `getRecentEventsByChannel` returns the PR's open, terminal state, AND your conversation-tab comments in one shot. |
| Inline review comments (the ones on diff hunks)? | Out of scope | Different endpoint (`pulls.listReviewComments`). Defer to v1.3 (reviews). |
| Strict-greater-than cursor filter? | Yes | `since` on the REST endpoint is inclusive on second-precision. A comment exactly at the cursor would re-arrive every tick. Idempotency would dedupe but the filter keeps the data clean. |
| Comment-list failure on one candidate? | Log + skip that candidate, AND pin the cursor at the input value | A 404 (private repo) shouldn't kill the tick. But if we let other candidates' comments advance the cursor, the failed candidate's comments would be skipped forever on retry. Pinning the cursor + idempotency on the captured ones lets the next tick re-process the entire window cleanly. (Codex round-1 review on PR #59 found this; see test "partial failure pins the cursor at the input value".) |
| Cursor advance on successful candidate with no own comments? | Yes - advance to `candidate.updated_at` | If we only advanced on emitted own-comments, candidates the user commented on historically would be re-fetched every tick when only teammates have activity. The candidate set grows unbounded and eventually hits the search 1000-result cap. GitHub guarantees `issue.updated_at >= max(comment.created_at)`, so advancing here never skips an unseen own comment. (Codex round-2 review on PR #59 found this; see test "advances cursor to candidate.updated_at even when no own comments emit".) |

## Surface area

**Per adapter (modified):**

- `src/config.ts`
  - Added `last_issue_opened_at` and `last_issue_commented_at` to `GitHubConfig` (both optional, fall back to 5-min first-run lookback).
  - `GitHubCursorField` extended to include the two new fields.
- `src/capture.ts`
  - New `IssueOpenedActivity` and `IssueCommentActivity` types.
  - New `captureIssueOpened` and `captureComment` private functions.
  - Dispatcher in `captureGitHubActivity` updated to route by `type`.
  - `CaptureSkipped.reason` extended with `"empty_body"`.
- `src/index.ts`
  - New `pollIssuesOpened` (single search query).
  - New `pollIssueComments` (two-stage: search + per-candidate `listComments`).
  - `pollOnce` now runs five queries in parallel via `Promise.all`.
  - `main()` reads + advances + saves the two new cursors.
  - `toBaseFields` parameterized with `requirePr` so issue queries can reuse it.
- `src/__tests__/capture.test.ts` - +14 tests (5 for issue_opened, 9 for issue_commented covering summary shape, allowlist gating, body-preview ellipsis, PR-vs-issue parent tagging, empty-body skip, idempotency namespace).
- `src/__tests__/config.test.ts` - +1 test covering all five cursors advancing together.
- `src/__tests__/poll.test.ts` - +6 tests for the two-stage comment fetch (happy path, foreign-author filter, cursor-boundary filter, per-candidate error isolation, no-advance-when-no-own-comments, plus issue_opened wiring).
- `README.md` - cursor table updated to five rows; ledger-shape section expanded; rate-limit math updated.

## Verification

- `(cd packages/usrcp-github && npm test)` -> 68/68 pass (was 45 in v1.1).
- `(cd packages/usrcp-local && npm test)` -> 422/422 (unchanged - no usrcp-local files touched).

## Out of scope (still)

- `pr_reopened` events (needs state tracking).
- Inline review comments on PRs (different endpoint; v1.3).
- Reviews you performed on others' PRs (v1.3).
- Commits authored by you.
- Discussions.
