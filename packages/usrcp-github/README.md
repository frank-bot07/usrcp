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
  "last_synced_at": "2026-05-17T12:00:00.000Z"
}
```

Set `allowlisted_orgs: []` to capture across every repo the token
can see (user-owned + public-collaborator). When the list is
non-empty, GitHub search filters server-side via `org:<slug>`
clauses so out-of-scope orgs' PRs are never fetched.

`last_synced_at` advances once per successful poll. Cursor uses
`created:>{last_synced_at}` so a PR is captured exactly once;
state-change events (merged / closed / reviewed) are out of
scope for v1.

## What lands in the ledger

Each PR becomes one `timeline_events` row:

- `intent`: `pr_opened`
- `channel_id`: `<owner>/<repo>#<number>` - stable PR identifier
- `external_user_id`: PR author login (always equals `github_login`)
- `tags`: `["github", "pull-request", "<owner>/<repo>"]`
- `detail`: full PR metadata (number, title, body, url, state,
  merged, created_at, updated_at)

Title and body are encrypted under the domain key; everything else
in `detail` goes through the global-key envelope.

## Rate limits

GitHub Search API: 30 requests/minute for authenticated users.
Default poll interval is 600s with one paginated query per tick,
so the rate-limit cost is negligible. The search query also caps
at 1000 results total per query - if you have more than 1000 PRs
in the time window since `last_synced_at`, the overflow is
permanently dropped. In practice this only matters on first run;
the wizard's `FIRST_RUN_LOOKBACK` is 5 minutes.

## Out of scope (v1)

- Issues, discussions, review comments.
- Reviews you submit on others' PRs.
- Commits authored by you (separate REST endpoint).
- PR state changes (merged, closed, reopened) - the cursor is on
  `created_at`, so any one PR fires exactly once.
