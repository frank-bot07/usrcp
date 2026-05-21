# USRCP Gmail — End-to-End Demo

> **Most users want `usrcp setup --adapter=gmail` instead.** This document is the manual proof script — what the wizard automates, plus a smoke test you can re-run after any change to verify capture still works.

What this walkthrough proves:

> **A message you send from Gmail lands as a structured ledger event within one poll interval, and is retrievable through the MCP server.**

The adapter is **capture-only** (no reader, no bot). Capture is the only criterion.

---

## Prereqs

- USRCP core installed (`brew install frank-bot07/usrcp/usrcp` or source clone) and `usrcp init` already run on this machine.
- OAuth client (client ID + secret) from a Google Cloud project with the **Gmail API** enabled and your email added as a test user on the OAuth consent screen. See [the README's Setup section](README.md#setup) for the Cloud Console click-path — it takes ~3 minutes the first time.

That's the only out-of-band work. Everything else happens in your terminal.

---

## Setup (one-time, ~2 minutes)

```bash
cd packages/usrcp-gmail
npm install
npm run build

usrcp setup --adapter=gmail
```

The wizard:
1. Prompts for `oauth_client_id` + `oauth_client_secret` (paste from Cloud Console).
2. Asks whether to authorise via browser (**default Yes**). Opens a localhost listener, prints a Google sign-in URL, and captures the redirect with your refresh token.
3. Validates by calling `users.getProfile` — a typo fails the wizard, not first poll.
4. Writes `~/.usrcp/gmail-config.json` at mode `0600` with the client secret + refresh token sealed under your USRCP master key.

If you're on a remote shell with no browser, answer **No** at the browser prompt — the wizard falls back to the OAuth-Playground manual path (paste `refresh_token` yourself). README has the playground walkthrough.

---

## The proof walkthrough

```bash
# Tail 1: the poller (leave running)
USRCP_PASSPHRASE="your-passphrase" usrcp-gmail
```

You should see a startup line; subsequent ticks log only when they capture or skip. Default poll interval is 600s — for a snappy demo, edit `~/.usrcp/gmail-config.json` and set `poll_interval_s: 60`.

```bash
# Tail 2: in another terminal, query the ledger via the MCP server
USRCP_PASSPHRASE="your-passphrase" usrcp recent --domain=email --limit=5
```

Now:

1. **From Gmail**, send any message. Subject: `usrcp demo proof`; body anything.
2. Wait until the next poll tick (≤60s if you bumped the interval).
3. The poller logs: `[usrcp-gmail] tick: captured=1 skipped=0`.
4. Re-run the `usrcp recent` query — the new event appears with:
   - `intent: email_sent`
   - `tags: ["gmail", "email", "sent"]`
   - `channel_id`: the Gmail thread id
   - `detail`: subject + body + recipients (decrypted on read; encrypted at rest)

If both the tick log and the `usrcp recent` hit fire, capture is proven end-to-end. ✅

---

## What this does NOT prove

- **Received messages.** v0 captures only what you authored. Inbox-side capture is a future PR.
- **Thread reconstruction.** Each message is its own event; `channel_id = threadId` is the hook for a follow-up that groups them.
- **Stream sync.** Gmail writes to the local ledger only, not `stream_events`.

---

## Troubleshooting

- **`invalid_grant` from Google** — the refresh token was revoked or never persisted. Re-run `usrcp setup --adapter=gmail`.
- **Wizard exits with "master key missing"** — you ran the wizard standalone instead of `usrcp setup --adapter=gmail`. The unified wizard supplies the master key needed to encrypt your OAuth secrets at rest.
- **Poller starts but never captures** — confirm you actually sent (not drafted) a message after the `last_synced_at` cursor. Drafts and trash are skipped by design.
- **OAuth consent screen rejects your email** — you forgot to add yourself as a test user under **APIs & Services → OAuth consent screen → Test users**. Add yourself and retry.
- **Passphrase needed**: if `usrcp init` was passphrase-mode, the poller needs `USRCP_PASSPHRASE` in its env (same as the rest of USRCP).
