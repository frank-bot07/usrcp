# USRCP Discord — End-to-End Vision Demo

This is the manual checklist for **criterion 2** from
[`tasks/00-discord-end-to-end-demo.md`](../../tasks/00-discord-end-to-end-demo.md):

> **Bot @-mention in channel B retrieves and references content from channel A.**

The automated tests in `src/__tests__/` already verify criteria 1, 3, 4,
and 5 (encrypted at rest, restart persistence, channel allowlist filter).
This document walks you through the one criterion that requires a live
Discord connection and a real Anthropic API call, plus (for later)
criterion 6 — recording a 60-90 second screencast for outreach purposes.

---

## First-run setup

Two pieces of account/credential work to do before the bot can run.
Neither lives in the repo; both go into `~/.usrcp/discord-config.json`
(mode `0600`) via the interactive prompt on first run.

### 1. Create a Discord bot application

1. Open <https://discord.com/developers/applications>.
2. **New Application** → name it whatever you like (e.g., `usrcp-dev`).
3. Sidebar → **Bot**. Reveal the token and save it somewhere secure; the
   first-run prompt will ask for it (masked input, not echoed to your
   terminal).
4. Under **Privileged Gateway Intents** toggle on **MESSAGE CONTENT INTENT**.
   Without this, Discord delivers message events with empty `.content` and
   capture silently does nothing.
5. Sidebar → **OAuth2 → URL Generator**. Scope: `bot`. Bot Permissions:
   at minimum `Read Messages/View Channels`, `Send Messages`, `Read Message History`.
   Visit the generated URL → invite the bot to the guild you control.

### 2. Get an Anthropic API key

1. Open <https://console.anthropic.com>.
2. **API Keys** → **Create Key**. Copy the value.
3. The bot uses Haiku 4.5 for message summaries and Sonnet 4.6 for
   @-mention replies; both are billed to whatever org the key is attached to.

### 3. Find your Discord user ID + channel IDs

Enable **Discord Developer Mode**:

- Discord → User Settings → Advanced → **Developer Mode** toggle on.

Then:

- Right-click **your own avatar** → **Copy User ID**. Only messages from
  this user ID will be captured — it is the single-user filter for v0.
- Right-click each channel you want to enroll → **Copy Channel ID**.
  Messages in any other channel are ignored.

---

## Running the bot

From the repo root:

```bash
cd packages/usrcp-discord
npm install            # installs discord.js, @anthropic-ai/sdk, links usrcp-local
npm run build          # compiles both packages (prebuild script does usrcp-local too)

# Start the bot. If your local USRCP ledger is passphrase-protected,
# pass USRCP_PASSPHRASE in the env. Otherwise it runs in dev mode.
USRCP_PASSPHRASE="your-passphrase" node dist/index.js
```

On first run the bot prompts for the four values above and writes
`~/.usrcp/discord-config.json` at mode `0600`. On subsequent runs it
reads from disk; no prompts. To re-prompt, delete the file or run:

```bash
node dist/index.js --reset-config
```

---

## The proof walkthrough (criterion 2)

Run this in one sitting. ~15 minutes once setup is done.

1. Start the bot in a terminal tab; leave it running.
2. In **channel A** (any allowlisted channel) send a message:
   > `I'm working on the USRCP discord adapter and specifically the cross-channel memory proof.`
3. Wait ~5 seconds for the capture summarizer + append to finish. You'll
   see a log line like `[usrcp-discord] captured message ... → event ...`.
4. Switch to **channel B** (a different allowlisted channel) and mention
   the bot:
   > `@usrcp-dev what was I just working on?`
5. **Expected:** the bot replies with a Discord message that references
   "USRCP discord adapter" or "cross-channel memory proof" or similar —
   information only available from channel A. ✅
6. Stop the bot (Ctrl-C), wait a few seconds, restart it.
7. In **channel C** (third allowlisted channel) mention the bot:
   > `@usrcp-dev remind me what I was working on earlier.`
8. **Expected:** the bot still answers with context from channel A. This
   proves persistence across bot restarts. ✅

If steps 5 and 8 both pass, criterion 2 is done. Update the commit note
(or the outreach tracker at `strategy/INTEGRATIONS.md`) and you can move
on.

---

## Criterion 6 — the screencast (deferred)

The project brief originally required a 60-90 second screencast of the
above walkthrough. That requirement is now deferred: it's an outreach
artifact (for pitching USRCP externally), not a vision-proof
requirement. Record it when you start talking to the Cursor / Continue /
Cline maintainers in `strategy/INTEGRATIONS.md`; until then, this
document is the reproducible script.

Suggested tooling when you do get to it:

- macOS: built-in screen recorder (`Cmd+Shift+5`) or Loom
- Record at 1080p, no voiceover needed; the chat exchange speaks for itself
- Commit to `docs/demos/discord-cross-channel.mp4` or drop a Loom link into `strategy/INTEGRATIONS.md`

---

## Troubleshooting

- **"capture silently does nothing"** — almost always the Message Content
  Intent is off in the Discord Developer Portal. Enable it, restart the bot.
- **"401 Unauthorized" from Anthropic** — API key isn't active; regenerate.
- **"bot replies but has no context"** — check that your user ID matches the
  author ID of captured messages. The capture filter throws out other users'
  messages.
- **"messages in the wrong channel got captured"** — check the allowlist in
  `~/.usrcp/discord-config.json`. Run with `--reset-config` to re-enter.
- **Local ledger passphrase**: if the local ledger was initialized with a
  passphrase via `usrcp init`, the bot needs `USRCP_PASSPHRASE` in its
  env. The first-run prompt does not ask for this; it's inherited from
  the parent ledger's setup.
