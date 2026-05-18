# usrcp-github

GitHub capture adapter for USRCP. Polls GitHub's REST search API for
pull requests authored by the configured user, and appends them to
the local USRCP ledger as encrypted timeline events. Capture-only
in v1 - no reader/bot.

## Install and run

```bash
cd packages/usrcp-github
npm install
npm run build
node dist/index.js                  # capture loop
node dist/index.js --reset-config   # re-prompt all config
```

First run is interactive. The wizard validates your personal access
token against `/user` before persisting, lists the orgs your token
can see, and lets you pick which to allowlist. A typo fails at the
wizard, not at first poll.

## Token scopes

Either token type works:

- **Classic PAT** (`ghp_*`): needs `repo` (or `public_repo` if you
  only care about public PRs) and `read:org` for the org listing
  step in setup.
- **Fine-grained PAT** (`github_pat_*`): grant `Pull requests: read`
  on every repo whose PRs you want captured.

The token is encrypted at rest under the USRCP master key (same
envelope as private.pem), in addition to file mode `0600`.

## Where secrets live

`~/.usrcp/github-config.json` at mode `0600`:

```json
{
  "github_token": "enc:<base64-AES-GCM-envelope>",
  "github_login": "chad",
  "allowlisted_orgs": ["anthropics", "usrcp"],
  "domain": "github",
  "poll_interval_s": 600,
  "last_synced_at": "2026-05-17T12:00:00.000Z",
  "last_merged_at": "2026-05-17T14:00:00.000Z",
  "last_closed_at": "2026-05-17T13:00:00.000Z",
  "last_issue_opened_at": "2026-05-17T15:00:00.000Z",
  "last_issue_commented_at": "2026-05-17T16:00:00.000Z",
  "last_pr_reviewed_at": "2026-05-17T17:00:00.000Z"
}
```

Set `allowlisted_orgs: []` to capture across every repo the token
can see (user-owned + public-collaborator). When the list is
non-empty, GitHub search filters server-side via `org:<slug>`
clauses so out-of-scope orgs' PRs are never fetched.

### Cursors

The adapter runs six independent queries per tick, each with its own cursor:

| Cursor field                | Query qualifier                                   | Event fired         |
|-----------------------------|---------------------------------------------------|---------------------|
| `last_synced_at`            | `author:X type:pr created:>{cursor}`              | `pr_opened`         |
| `last_merged_at`            | `author:X type:pr is:merged merged:>{cursor}`     | `pr_merged`         |
| `last_closed_at`            | `author:X type:pr is:closed is:unmerged closed:>{cursor}` | `pr_closed` |
| `last_issue_opened_at`      | `author:X type:issue created:>{cursor}`           | `issue_opened`      |
| `last_issue_commented_at`   | `commenter:X updated:>{cursor}` + `listComments`  | `issue_commented`   |
| `last_pr_reviewed_at`       | `reviewed-by:X type:pr updated:>{cursor}` + `listReviews` | `pr_reviewed` |

Two-stage fetches (`issue_commented` and `pr_reviewed`) work the same way: search finds candidate issues/PRs the user has touched since the cursor, then a REST endpoint per candidate returns the underlying objects (comments or reviews) filtered to the user's authorship + strictly-greater-than-cursor timestamp. Idempotency keys ensure exactly-once even when the same candidate appears in multiple ticks.

Both two-stage flows handle partial failures the same way:

- If `listComments` / `listReviews` fails on **any** candidate this tick, the cursor pins at the input value so the next tick re-processes the entire window.
- After a successful empty scan, the cursor advances to `candidate.updated_at` so candidates the user historically touched don't get re-fetched indefinitely when only others have new activity.

Each PR captures **at most one** terminal event because `is:merged` and `is:closed is:unmerged` are mutually exclusive in the search index. A merged PR can never un-merge, so `pr_merged` is genuinely terminal.

## What lands in the ledger

Each PR contributes up to two events (`pr_opened` + one terminal state event), plus a `pr_reviewed` event per review you submitted on someone else's PR. Each issue contributes one `issue_opened`. Comments add one `issue_commented` per author-matching comment. All events on the same issue/PR share `channel_id = <owner>/<repo>#<number>` (GitHub uses one numbering namespace per repo), so `getRecentEventsByChannel` returns the full lifecycle - PR open, comments, reviews, terminal state - in one shot.

Per-event detail:

- **`pr_opened`** - tags `["github", "pull-request", "<owner>/<repo>"]`, idempotency `github:pr:<owner>/<repo>#<number>`. Detail includes title, body, url, state, merged, created_at, updated_at.
- **`pr_merged`** / **`pr_closed`** - tags `[..., "merged"]` or `[..., "closed"]`, idempotency `github:pr-{merged,closed}:<owner>/<repo>#<number>`. Detail includes `state_at` (the merge/close timestamp).
- **`issue_opened`** - tags `["github", "issue", "<owner>/<repo>"]`, idempotency `github:issue:<owner>/<repo>#<number>`. Detail includes title, body, url, state, created_at, updated_at.
- **`issue_commented`** - tags `["github", "comment", "<pull-request|issue>", "<owner>/<repo>"]`, idempotency `github:issue-comment:<comment_id>`. `thread_id` = comment_id. Detail includes the full comment body, `is_pr_parent` flag, comment URL, parent issue URL, and timestamps.
- **`pr_reviewed`** - tags `["github", "review", "<approved|requested-changes|reviewed>", "<owner>/<repo>"]`, idempotency `github:pr-review:<review_id>`. `thread_id` = review_id. Detail includes review body (may be empty for plain Approves), state (APPROVED / CHANGES_REQUESTED / COMMENTED), submitted_at, pr_url, and the PR author's login. PENDING (draft) and DISMISSED reviews are skipped.

`external_user_id` distinguishes who the "other party" was: the actor for `pr_opened`/`issue_opened`/`issue_commented` (always you), and the **PR author** for `pr_reviewed` (so agents can grep "reviews I did for Alice"). Title and body fields are encrypted under the domain key; everything else in `detail` goes through the global-key envelope.

## Rate limits

GitHub Search API: 30 requests/minute for authenticated users.
Default poll interval is 600s with five paginated search queries
per tick (opened / merged / closed / issue_opened / commented-candidates
/ reviewed-candidates), so the rate-limit cost stays under
10/min. The two-stage flows then issue per-candidate REST calls
(`listComments` for issue_commented, `listReviews` for pr_reviewed);
those count against the much-higher 5000/hr core REST cap
(~80/min). For most users this hovers in the single digits per
tick.

Each search query caps at 1000 results - if you have more than
1000 events in the time window since a cursor, overflow is
permanently dropped. In practice this only matters on first run;
the daemon's first-run lookback is 5 minutes.

## Out of scope (current)

- Discussions (separate API).
- Inline review comments left on individual diff hunks (different
  endpoint from `pulls.listReviews`; the top-level review object
  is captured, but per-line comments are deferred).
- Commits authored by you (separate REST endpoint).
- `pr_reopened` events. The search index doesn't expose "was
  closed, is now open" as a query, so reopens would require
  state tracking that's deferred to a future PR.
