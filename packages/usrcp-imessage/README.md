# usrcp-imessage

iMessage capture adapter for USRCP. Polls the macOS Messages.app
database (`~/Library/Messages/chat.db`) via [`steipete/imsg`](https://github.com/steipete/imsg)
and appends new messages from allowlisted chats as encrypted timeline
events in the local USRCP ledger.

**macOS-only.** Requires Full Disk Access for the binary that runs the
adapter (Terminal, iTerm, Node binary, etc.) so it can read `chat.db`.

## Install and run

```bash
cd packages/usrcp-imessage
npm install
npm run build
node dist/index.js                  # capture loop
node dist/index.js --reset-config   # re-prompt all config
```

First run is interactive: walks you through `imsg` detection, the FDA
check, your user handle (phone or email), the chat allowlist, an
optional message prefix filter, and an Anthropic API key (used by the
companion reader, not capture itself).

## Where secrets live

`~/.usrcp/imessage-config.json` at mode `0600`:

```json
{
  "anthropic_api_key": "...",
  "user_handle": "+15551234567",
  "allowlisted_chats": ["chatNNN", "chatMMM"],
  "prefix": "",
  "last_rowid": 123456
}
```

`last_rowid` is the high-water mark from `chat.db`, advanced after each
poll so the adapter doesn't re-emit captured messages.

## What lands in the ledger

Each iMessage becomes a `timeline_events` row with:

- `channel_id` — the iMessage `chat_identifier`
- `external_user_id` — sender's handle
- All free-text fields (summary, detail) encrypted under the global key

## Stream mode (Phase 6)

When `usrcp-stream` is installed alongside this adapter, you can choose where captured messages land via `--mode`:

- `--mode ledger`  — user-sent messages only (is_from_me=1), written to the local USRCP ledger. Existing behavior.
- `--mode stream`  — allowlisted, **both sides** (is_from_me=1 outbound + incoming inbound) flow into the encrypted `stream.db`. No ledger writes. iMessage has no notion of "bot," so no bot filter applies.
- `--mode both`    — ledger keeps the is_from_me filter; stream captures both sides on allowlisted chats. **Default when `usrcp-stream` is installed.**

If `usrcp-stream` is not installed, the default is `--mode ledger`. Passing `--mode stream` or `--mode both` without the package installed will error at startup with a message instructing you to install it.

```bash
USRCP_PASSPHRASE=… node dist/index.js --mode both
```

Stream events on the same `(surface, channel_ref)` within `same_channel_window_ms` are stitched into one thread by the cross-surface stitcher; see `packages/usrcp-stream/README.md` for the keyspace, threat model, and recall surface.
