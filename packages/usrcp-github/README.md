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
  "last_closed_at": "2026-05-17T13:00:00.000Z"
}
```

Set `allowlisted_orgs: []` to capture across every repo the token
can see (user-owned + public-collaborator). When the list is
non-empty, GitHub search filters server-side via `org:<slug>`
clauses so out-of-scope orgs' PRs are never fetched.

### Cursors

The adapter runs three independent queries per tick, each with its own cursor:

| Cursor field      | Query qualifier                                | Event fired |
|-------------------|------------------------------------------------|-------------|
| `last_synced_at`  | `created:>{cursor}`                            | `pr_opened` |
| `last_merged_at`  | `is:merged merged:>{cursor}`                   | `pr_merged` |
| `last_closed_at`  | `is:closed is:unmerged closed:>{cursor}`       | `pr_closed` |

Each PR captures **at most one** terminal event because `is:merged` and `is:closed is:unmerged` are mutually exclusive in the GitHub search index. A merged PR can never un-merge, so `pr_merged` is genuinely terminal. A PR closed without merge that's later reopened and merged will fire both `pr_closed` and `pr_merged` (different idempotency keys).

## What lands in the ledger

Each PR contributes up to two events: `pr_opened` (on first observation) and a terminal state event (`pr_merged` or `pr_closed`). All events for the same PR share `channel_id = <owner>/<repo>#<number>`, so `getRecentEventsByChannel` returns the full lifecycle in one shot.

Per-event detail:

- **`pr_opened`** - tags `["github", "pull-request", "<owner>/<repo>"]`, idempotency `github:pr:<owner>/<repo>#<number>`. Detail includes title, body, url, state, merged, created_at, updated_at.
- **`pr_merged`** - tags `[..., "merged"]`, idempotency `github:pr-merged:<owner>/<repo>#<number>`. Detail includes `state_at` (the merge timestamp).
- **`pr_closed`** - tags `[..., "closed"]`, idempotency `github:pr-closed:<owner>/<repo>#<number>`. Detail includes `state_at` (the close timestamp).

`external_user_id` is always the PR author login (equal to `github_login`). Title fields are encrypted under the domain key; everything else in `detail` goes through the global-key envelope.

## Rate limits

GitHub Search API: 30 requests/minute for authenticated users.
Default poll interval is 600s with three paginated queries per
tick (opened/merged/closed), so the rate-limit cost is still
negligible. Each query caps at 1000 results - if you have more
than 1000 PRs in the time window since the cursor, overflow is
permanently dropped. In practice this only matters on first run;
the daemon's first-run lookback is 5 minutes.

## Out of scope (current)

- Issues, discussions, issue comments.
- Reviews you submit on others' PRs.
- Commits authored by you (separate REST endpoint).
- `pr_reopened` events. The search index doesn't expose "was
  closed, is now open" as a query, so reopens would require
  state tracking that's deferred to a future PR.
