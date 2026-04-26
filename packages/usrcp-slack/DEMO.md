# USRCP Slack — End-to-End Vision Demo

> **Most users want `usrcp setup` instead.** This document is a reference for what the wizard automates. Follow these steps manually only if you have a reason not to use the wizard.

This is the manual walkthrough for the Slack adapter's cross-channel memory proof:

> **Bot reply in channel B references content captured from channel A.**

The automated tests in `src/__tests__/` already verify capture filters, ciphertext at rest, restart persistence, and thread_ts preservation. This document walks you through the one criterion that requires a live Slack connection and a real Anthropic API call.

---

## First-run setup

Two tokens are required. Both are non-obvious to find the first time.

### 1. Create a Slack app

1. Open <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g., `usrcp-dev`) and pick your workspace.

In the app config:

**OAuth & Permissions** → Add bot scopes:
```
app_mentions:read  channels:history  chat:write
groups:history     im:history        mpim:history
users:read         channels:read     groups:read
im:read            mpim:read
```

**Socket Mode** → Enable it. Generate an **App-Level Token** with scope `connections:write`. Copy — it starts with `xapp-`. This token powers the persistent WebSocket connection; no public HTTPS endpoint needed.

**Event Subscriptions** → Enable. Subscribe to bot events:
```
message.channels  message.groups  message.im  message.mpim  app_mention
```

**Install to Workspace** → click and approve. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 2. Get an Anthropic API key

1. Open <https://console.anthropic.com>.
2. **API Keys** → **Create Key**. Copy the value.
3. The bot uses Haiku 4.5 for message summaries and Sonnet 4.6 for @-mention / DM replies.

### 3. Invite the bot to your channels

In each Slack channel you want to monitor:
```
/invite @usrcp-dev
```

The bot must be a member to receive message events. DMs to the bot work without an invite.

### 4. Find your Slack user ID

In Slack: click your own avatar → **View profile** → **...** menu → **Copy member ID**. It starts with `U`. This is the capture filter — only your messages are captured.

---

## Running the bot

```bash
cd packages/usrcp-slack
npm install
npm run build       # compiles usrcp-local too (prebuild script)

# Start the bot — no public HTTPS endpoint needed (Socket Mode).
# If your USRCP ledger is passphrase-protected, pass USRCP_PASSPHRASE.
USRCP_PASSPHRASE="your-passphrase" node dist/index.js
```

Or use the unified wizard (recommended):

```bash
usrcp setup --adapter=slack
# then:
usrcp-slack
# or: USRCP_PASSPHRASE=<pp> usrcp-slack
```

Config is saved to `~/.usrcp/slack-config.json` (mode 0600). To re-configure:

```bash
usrcp-slack --reset-config
```

---

## The proof walkthrough

Run this in one sitting. ~15 minutes once setup is done.

1. Start the bot in a terminal tab; leave it running. You should see:
   ```
   [usrcp-slack] Connected via Socket Mode
   [usrcp-slack] Listening on channels: C01234567890, C09876543210
   ```

2. In **channel A** (any allowlisted channel) send a message (as yourself, not a bot):
   > `I'm working on the USRCP Slack adapter — specifically the cross-channel memory proof.`

3. Wait ~3 seconds for the capture summarizer to finish. You'll see a log line:
   ```
   [usrcp-slack] captured ts=... channel=... → event ... (seq ...)
   ```

4. Switch to **channel B** (a different allowlisted channel) and mention the bot:
   > `@usrcp-dev what was I just working on?`

5. **Expected:** the bot replies in-thread with a Slack message referencing "USRCP Slack adapter" or "cross-channel memory proof" — information only available from channel A. ✅

6. Stop the bot (Ctrl-C), wait a few seconds, restart it.

7. In **channel A or B** mention the bot:
   > `@usrcp-dev remind me what I was doing before.`

8. **Expected:** the bot still answers with context from step 2. This proves persistence across bot restarts. ✅

9. Send the bot a **direct message** (DM):
   > `What have I been working on today?`

10. **Expected:** the bot replies with cross-platform context including the Slack capture from step 2. DMs bypass the channel allowlist check and always trigger a reply. ✅

---

## Troubleshooting

- **Socket Mode won't connect / `invalid_auth` on app-level token** — the app-level token is missing the `connections:write` scope. In the app config: **Basic Information → App-Level Tokens** → delete the old token, create a new one, and explicitly add the `connections:write` scope.

- **Bot receives no messages** — check that the bot is invited to the channel (`/invite @your-bot-name`). Also confirm the relevant Event Subscriptions are enabled (`message.channels`, `message.groups`, etc.).

- **Capture logs show nothing** — verify `user_id` in `~/.usrcp/slack-config.json` matches the Slack member ID from your profile (starts with `U`). The filter silently discards messages from other users.

- **"401 Unauthorized" from Anthropic** — API key isn't active; regenerate from the Anthropic console.

- **Bot replies but has no context** — the capture filter is working but the Ledger path or passphrase may differ. Ensure `USRCP_PASSPHRASE` matches what was used when the ledger was initialized.

- **Only first 200 channels shown during setup** — `conversations.list` is capped at 200. If you have more channels, enter IDs manually when prompted.
