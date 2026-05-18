# usrcp-github v1.1: PR state changes

Date: 2026-05-17
Branch: `feat/github-pr-state-changes`
Follow-on to #57.

## Why

#57 shipped `pr_opened` events. Real agents want to know whether a
PR shipped: "did Chad's adapter PR get merged" is a much more
useful question than "did Chad open a PR named adapter". State
changes (merged / closed) close that gap.

Designed so v1 events still capture cleanly - the new cursors
live alongside `last_synced_at`, and the new idempotency keys
(`github:pr-merged:*`, `github:pr-closed:*`) never collide with
v1's (`github:pr:*`).

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Two cursors or one? | Two: `last_merged_at` and `last_closed_at` | Independent queries (`is:merged merged:>X` vs `is:closed is:unmerged closed:>X`). Each cursor advances only when its query produces output, so a busy-merging week doesn't replay the same closed PRs. |
| `pr_reopened` event? | Out of scope | The search index doesn't have a "reopened" qualifier. Detecting state transitions requires remembering what we last saw, which is a bigger storage / cursor change. Defer to a future PR. |
| Cap how many queries per tick? | Three (opened + merged + closed), in parallel | Search API limit is 30/min authenticated. Three queries per 600s tick is far under the cap. Parallel `Promise.all` keeps tick latency low. |
| Backward-compatible config? | Yes - all three cursor fields are optional, missing ones fall back to the first-run lookback | v1 configs upgrade in-place. The first tick after upgrade does a "5-minute lookback for the merged/closed queries too" which is fine. |
| Same channel_id across event types? | Yes - `<owner>/<repo>#<number>` for all three | `getRecentEventsByChannel` returns the full lifecycle of a PR. |
| Cursor save API | Refactored to `saveCursors({ ... })` + `flushCursors()` | The v1 `saveLastSyncedAt` couldn't represent advancing multiple cursors in one tick. Kept as a thin deprecated wrapper so any internal caller still works. |
| Skip items missing the matching state field? | Yes (defensive) | GitHub guarantees `merged_at` is present on `is:merged` results; if drift ever breaks that, we'd write `null` to the cursor and burn the lookback. Skipping is safer. |

## Surface area

- `packages/usrcp-github/src/config.ts`
  - Added `last_merged_at` and `last_closed_at` to `GitHubConfig`.
  - Added `GitHubCursorField` type.
  - Refactored `saveLastSyncedAt`/`flushLastSyncedAt` into `saveCursors`/`flushCursors`; v1 names kept as deprecated thin wrappers.
- `packages/usrcp-github/src/capture.ts`
  - Added `PullRequestStateChangeActivity` and `GitHubActivity` union.
  - Split `captureGitHubActivity` into a dispatcher + two per-type capture functions. Org-allowlist and empty-title checks moved into the shared dispatcher.
- `packages/usrcp-github/src/index.ts`
  - Three independent queries per tick (`pollOpened`, `pollTerminal`).
  - New `CursorState` parameter to `pollOnce` (replaces the single-string `sinceIso`).
  - Tick logs all three cursor advances.
- `packages/usrcp-github/src/__tests__/capture.test.ts` - +6 tests for the new event types.
- `packages/usrcp-github/src/__tests__/config.test.ts` - +6 tests for `saveCursors`/`flushCursors`.
- `packages/usrcp-github/src/__tests__/poll.test.ts` - new file, 4 tests covering the three-query design end-to-end with a stubbed Octokit.
- `packages/usrcp-github/README.md` - new "Cursors" table; updated rate-limit and ledger-shape sections.

## Verification

- `(cd packages/usrcp-github && npm test)` -> 45/45 pass.
- `(cd packages/usrcp-local && npm test)` -> 422/422 (unchanged - no usrcp-local files touched).

## Out of scope (still)

- `pr_reopened` - needs state tracking.
- Issue / discussion / commit / review events - separate adapters' worth.
- Review activity on others' PRs - would need a fourth query against the reviews endpoint (not search-indexed the same way).
