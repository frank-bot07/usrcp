# usrcp-slack

Slack capture+reader adapter for USRCP. Connects via [Bolt for
JavaScript](https://slack.dev/bolt-js/) in Socket Mode, captures the
configured user's messages from allowlisted channels and DMs as
encrypted timeline events, and replies with cross-channel context when
the bot is @-mentioned.

Mirrors the `usrcp-discord` shape: vision-proof of the same idea on a
different conversation surface.

## Install and run

```bash
cd packages/usrcp-slack
npm install
npm run build
node dist/index.js                  # capture + reader loop
node dist/index.js --reset-config   # re-prompt all config
```

The setup wizard validates each token against the Slack API as you
enter it (so a typo fails at the wizard, not at first event), and
warns proactively about common traps (bot-token vs user-token, Socket
Mode tier, missing event subscriptions).

## Where secrets live

`~/.usrcp/slack-config.json` at mode `0600`:

```json
{
  "slack_bot_token": "xoxb-...",
  "slack_app_token": "xapp-...",
  "anthropic_api_key": "...",
  "allowlisted_channels": ["C0123ABC", "D9876XYZ"],
  "user_id": "U0001ABC"
}
```

`user_id` is the workspace user ID of the human being captured — *not*
the bot's user ID.

## What lands in the ledger

Each captured message becomes a `timeline_events` row:

- `channel_id` — Slack channel or DM ID
- `thread_id` — optional Slack `thread_ts`
- `external_user_id` — Slack user ID
- Message body encrypted under the global key

## Stream mode (Phase 6)

When `usrcp-stream` is installed alongside this adapter, you can choose where captured messages land via `--mode`:

- `--mode ledger`  — user-only messages, written to the local USRCP ledger. Existing behavior.
- `--mode stream`  — bot-skipped (`bot_id` events excluded), allowlisted, **every human's messages** (yours + everyone else's) flow into the encrypted `stream.db`. No ledger writes.
- `--mode both`    — ledger keeps the user-only filter; stream captures all human messages on allowlisted channels. **Default when `usrcp-stream` is installed.**

DMs (`channel_type === "im"`) are still handled by the separate DM listener and are not subject to the channel allowlist for reply purposes; stream capture in DMs requires adding the DM channel ID to `allowlisted_channels`.

If `usrcp-stream` is not installed, the default is `--mode ledger` and the stream flag is unrecognized.

```bash
USRCP_PASSPHRASE=… node dist/index.js --mode both
```

Stream events on the same `(surface, channel_ref)` within `same_channel_window_ms` are stitched into one thread by the cross-surface stitcher; see `packages/usrcp-stream/README.md` for the keyspace, threat model, and recall surface.
