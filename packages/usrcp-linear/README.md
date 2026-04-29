# usrcp-linear

Linear capture adapter for USRCP. Polls Linear's GraphQL API for
issues and comments authored by the configured user, and appends them
to the local USRCP ledger as encrypted timeline events. Capture-only —
no reader/bot.

## Install and run

```bash
cd packages/usrcp-linear
npm install
npm run build
node dist/index.js                  # capture loop
node dist/index.js --reset-config   # re-prompt all config
```

First run is interactive. The wizard validates your API key against
`viewer` before persisting, lists your teams, and lets you pick which
to allowlist. A typo fails at the wizard, not at first poll.

## Where secrets live

`~/.usrcp/linear-config.json` at mode `0600`:

```json
{
  "linear_api_key": "lin_api_...",
  "allowlisted_team_ids": ["<team-uuid>", "<team-uuid>"],
  "domain": "work",
  "poll_interval_s": 60,
  "last_synced_at": "2026-04-27T12:00:00.000Z"
}
```

`last_synced_at` is advanced once per successful poll. Comments are
filtered server-side via `CommentFilter.issue.team.id.in` so the
allowlist is honored at the API boundary, not after the fact.

## What lands in the ledger

Each issue and comment becomes a `timeline_events` row:

- Issues: `channel_id = <issue-uuid>`
- Comments: `channel_id = <parent-issue-uuid>`, `thread_id = <comment-uuid>`
  — keyed this way so `getRecentEventsByChannel(<issue-uuid>)` returns
  the issue and all its comments together
- `external_user_id` — Linear user ID of the author
- Title / body fields encrypted under the global key
