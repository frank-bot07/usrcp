# usrcp-discord

Discord capture+reader adapter for USRCP. Listens to the configured
user's messages, records them as encrypted timeline events in the local
USRCP ledger, and replies with cross-channel context when @-mentioned.

This is the **vision-proof spike** — the smallest artifact that
demonstrates USRCP's actual goal (structured state that flows across
conversation surfaces), scoped down to a single user on a single
platform on a single machine.

## Status

- **Criteria 1, 3, 4, 5** from [`tasks/00-discord-end-to-end-demo.md`](../../tasks/00-discord-end-to-end-demo.md)
  are covered by the automated tests in `src/__tests__/`. Run
  `npm test` to see them pass.
- **Criterion 2** (bot @-mention in channel B references content from
  channel A) requires a live Discord bot token, an Anthropic API key, a
  real guild, and the user actually posting messages. It's the manual
  walkthrough in [`DEMO.md`](./DEMO.md).
- **Criterion 6** (60–90 second screencast) is deferred — it's an
  outreach artifact, not a vision-proof requirement. Produce it when
  you start external outreach per `strategy/INTEGRATIONS.md`.

## Install and run

```bash
cd packages/usrcp-discord
npm install
npm run build
node dist/index.js                  # first run: interactive setup
node dist/index.js --reset-config   # re-prompt all config
```

See [`DEMO.md`](./DEMO.md) for first-run credential setup (Discord bot
token + Anthropic API key), the live cross-channel proof script, and
troubleshooting.

## What it depends on from `usrcp-local`

Three schema additions, all encrypted at rest:

- `timeline_events.channel_id` — conversation surface identifier
- `timeline_events.thread_id` — optional Discord thread
- `timeline_events.external_user_id` — Discord user ID

Plus `timeline_events.channel_hash` — a deterministic HMAC of
`channel_id` under the master key, so `getRecentEventsByChannel` can do
indexed lookups without decrypting every row.

All three encrypted columns use the **global** key (not the per-domain
key) because a single channel surface can carry events across multiple
USRCP domains, and we need one deterministic hash space for
`channel_hash`.

## Where secrets live

`~/.usrcp/discord-config.json` at mode `0600`:

```json
{
  "discord_bot_token": "...",
  "anthropic_api_key": "...",
  "allowlisted_channels": ["<id>", "<id>"],
  "user_id": "<your-discord-user-id>"
}
```

The interactive first-run prompt uses masked input (characters echo as
`*`) for the two secrets so they don't land in shell history or
terminal scrollback.
