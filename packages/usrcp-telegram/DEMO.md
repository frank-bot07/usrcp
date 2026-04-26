# USRCP Telegram — End-to-End Vision Demo

This is the manual checklist for **criterion 2** of the Telegram adapter:

> **Bot @-mention in chat B retrieves and references content from chat A.**

The automated tests in `src/__tests__/` verify criteria 1, 3, 4, and 5
(encrypted at rest, restart persistence, chat allowlist filter).
This document walks through the one criterion that requires a live Telegram
bot connection and a real Anthropic API call.

---

## WARNING: Privacy mode must be disabled BEFORE running the bot

> **If you skip this step, the bot will see ONLY commands and direct @-mentions
> in groups. Regular messages — the ones USRCP needs to capture — will be
> silently invisible to the bot. Capture will appear to work but will record
> nothing.**
>
> In Telegram: open a chat with **@BotFather** → `/setprivacy` → select your
> bot → choose **Disable**.
>
> You only need to do this once per bot. After setting privacy mode to Disable,
> restart the bot if it is already running.

This is Telegram's equivalent of Discord's MESSAGE_CONTENT_INTENT toggle.

---

## First-run setup

All credentials live in `~/.usrcp/telegram-config.json` (mode `0600`),
written by the interactive first-run prompt. Nothing is committed to the repo.

### 1. Create a Telegram bot with BotFather

1. Open Telegram and start a chat with <https://t.me/BotFather>.
2. Send `/newbot`. Follow the prompts to choose a name and username
   (username must end in `bot`, e.g., `usrcp_dev_bot`).
3. BotFather sends you a token like `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`.
   Copy it somewhere secure — the first-run prompt will ask for it (masked input).

### 2. Disable privacy mode (REQUIRED for group capture)

> **Do this immediately after creating the bot. It is easy to forget and hard
> to diagnose later.**

In the BotFather chat:

1. Send `/setprivacy`.
2. BotFather asks which bot — select your new bot.
3. Choose **Disable**.
4. BotFather confirms "Privacy mode is disabled for [your bot]."

Without this step:
- In groups/supergroups: the bot sees only `/commands` and messages that
  explicitly @-mention it. All other messages are hidden at the API level.
- In private chats (DMs): privacy mode has no effect; DMs always work.

### 3. Get an Anthropic API key

1. Open <https://console.anthropic.com>.
2. **API Keys** → **Create Key**. Copy the value.
3. The bot uses Haiku 4.5 for message summaries and Sonnet 4.6 for
   mention replies; both are billed to whatever org the key is attached to.

### 4. Find your Telegram user ID and chat IDs

**Your user ID:**

Send any message to <https://t.me/userinfobot>. It replies with your
numeric user ID (e.g., `111222333`). Only messages from this user ID will
be captured.

**Chat IDs for groups/supergroups:**

Forward any message from the target group to `@userinfobot`. It shows the
chat's numeric ID. Group and supergroup IDs are negative numbers
(e.g., `-1001234567890`). Enter them exactly, including the minus sign.

**Private chat (DM) with yourself:**

Your DM chat ID equals your user ID (positive number).

---

## Running the bot

```bash
cd packages/usrcp-telegram
npm install            # installs grammy, @anthropic-ai/sdk, links usrcp-local
npm run build          # compiles both packages (prebuild script does usrcp-local too)

# Start the bot (long polling). If your local USRCP ledger is passphrase-
# protected, pass USRCP_PASSPHRASE in the env.
USRCP_PASSPHRASE="your-passphrase" node dist/index.js
```

On first run the bot prompts for the four values above and writes
`~/.usrcp/telegram-config.json` at mode `0600`. On subsequent runs it
reads from disk; no prompts. To re-prompt, delete the file or run:

```bash
node dist/index.js --reset-config
```

---

## The proof walkthrough (criterion 2)

Run this in one sitting. About 15 minutes once setup is done.

1. Start the bot in a terminal tab; leave it running.
2. In **chat A** (any allowlisted group/supergroup) send a message — no
   @-mention needed, just plain text:
   > `I'm working on the USRCP telegram adapter and specifically the cross-chat memory proof.`
3. Wait ~5 seconds for capture + ledger append to finish. The terminal shows
   a log line like `[usrcp-telegram] captured message ... → event ...`.
4. Switch to **chat B** (a different allowlisted chat) and mention the bot:
   > `@your_bot_username what was I just working on?`
5. **Expected:** the bot replies (as a quoted message) referencing
   "USRCP telegram adapter" or "cross-chat memory proof" — information only
   available from chat A.
6. Stop the bot (Ctrl-C), wait a few seconds, restart it.
7. In **chat C** (a third allowlisted chat) mention the bot:
   > `@your_bot_username remind me what I was working on earlier.`
8. **Expected:** the bot still answers with context from chat A. This proves
   persistence across bot restarts.

If steps 5 and 8 both pass, criterion 2 is done.

---

## Troubleshooting

- **"capture silently does nothing" in groups** — almost always privacy mode
  is still enabled. Go to BotFather → `/setprivacy` → your bot → **Disable**,
  then restart the bot. This is the most common first-run failure.
- **"capture silently does nothing" in DMs** — check that your Telegram user ID
  matches the `user_id` in `~/.usrcp/telegram-config.json`. Run `--reset-config`.
- **"401 Unauthorized" from Anthropic** — API key isn't active; regenerate at
  <https://console.anthropic.com>.
- **"bot replies but has no context"** — check that the chat ID in
  `allowlisted_chats` matches the actual chat. Forward a message from the group
  to `@userinfobot` to confirm. Run `--reset-config` to re-enter.
- **Bot doesn't respond to @-mentions either** — confirm the bot is actually
  a member of the group and has "Send Messages" permission.
- **Local ledger passphrase**: if the local ledger was initialized with a
  passphrase via `usrcp init`, the bot needs `USRCP_PASSPHRASE` in its env.
  The first-run prompt does not ask for it; it's inherited from the parent
  ledger's setup.
