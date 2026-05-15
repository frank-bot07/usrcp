# usrcp-telegram

Telegram capture+reader adapter for USRCP. Long-polls the Telegram Bot
API (`getUpdates`), captures the configured user's messages from
allowlisted chats as encrypted timeline events, and replies with
cross-channel context when the bot is @-mentioned or DM'd.

Mirrors the `usrcp-discord` and `usrcp-slack` adapters: vision-proof of
the same idea on a different conversation surface.

## Install and run

```bash
cd packages/usrcp-telegram
npm install
npm run build
node dist/index.js                  # capture + reader loop
node dist/index.js --reset-config   # re-prompt all config
```

First run is interactive: walks you through the bot token (from
[@BotFather](https://t.me/BotFather)), the chat allowlist (use
`/start` in a chat then read its ID via `getUpdates`), your Telegram
user ID (the human being captured, not the bot's), and an Anthropic
API key for the reader.

> ⚠️ **Privacy mode trap.** Bots created via @BotFather have privacy
> mode **on** by default — they only see messages that @-mention them
> or are commands (`/foo`). For full capture in groups, run
> `/setprivacy` in @BotFather and disable it for this bot.

## Where secrets live

`~/.usrcp/telegram-config.json` at mode `0600`:

```json
{
  "telegram_bot_token": "1234567890:AA...",
  "anthropic_api_key": "...",
  "allowlisted_chats": ["-100123456789", "987654321"],
  "user_id": "987654321"
}
```

Chat IDs are strings because Telegram supergroup IDs (`-100…`) exceed
JavaScript's safe integer range.

## What lands in the ledger

Each captured message becomes a `timeline_events` row:

- `channel_id` — Telegram chat ID
- `thread_id` — optional `message_thread_id` for forum topics
- `external_user_id` — Telegram user ID
- Message body encrypted under the global key

## Stream mode (Phase 6)

When `usrcp-stream` is installed alongside this adapter, you can choose where captured messages land via `--mode`:

- `--mode ledger`  — user-only messages, written to the local USRCP ledger. Existing behavior.
- `--mode stream`  — bot-skipped, allowlisted, **every human's messages** (yours + everyone else's) flow into the encrypted `stream.db`. No ledger writes.
- `--mode both`    — ledger keeps the user-only filter; stream captures all human messages on allowlisted chats. **Default when `usrcp-stream` is installed.**

If `usrcp-stream` is not installed, the default is `--mode ledger` and the stream flag is unrecognized.

```bash
USRCP_PASSPHRASE=… node dist/index.js --mode both
```

Stream events on the same `(surface, channel_ref)` within `same_channel_window_ms` are stitched into one thread by the cross-surface stitcher; see `packages/usrcp-stream/README.md` for the keyspace, threat model, and recall surface.
