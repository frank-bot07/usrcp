# USRCP Google Calendar — End-to-End Demo

> **Most users want `usrcp setup --adapter=google-calendar` instead.** This is the manual proof script — what the wizard automates, plus a smoke test you can re-run after any change to verify capture still works.

What this walkthrough proves:

> **A meeting on your primary calendar that has already ended lands as a structured `event_attended` ledger event within one poll interval, and is retrievable through the MCP server.**

The adapter is **capture-only** (no reader, no bot). Capture is the only criterion.

---

## Prereqs

- USRCP core installed and `usrcp init` already run.
- OAuth client (client ID + secret) from a Google Cloud project with the **Google Calendar API** enabled and your email added as a test user on the OAuth consent screen. See [the README's Setup section](README.md#setup) for the Cloud Console click-path.

Same OAuth posture as the Gmail adapter — different scope (`calendar.readonly`).

---

## Setup (one-time, ~2 minutes)

```bash
cd packages/usrcp-google-calendar
npm install
npm run build

usrcp setup --adapter=google-calendar
```

The wizard:
1. Prompts for `oauth_client_id` + `oauth_client_secret`.
2. Asks whether to authorise via browser (**default Yes**). Opens a localhost listener, captures the redirect, persists the refresh token.
3. Validates by fetching the primary calendar's metadata — a typo fails the wizard, not first poll.
4. Writes `~/.usrcp/google-calendar-config.json` at mode `0600` with secrets sealed under the USRCP master key.

If no browser is available, answer **No** and follow the OAuth-Playground manual path documented in the README.

---

## The proof walkthrough

```bash
# Tail 1: the poller (leave running)
USRCP_PASSPHRASE="your-passphrase" usrcp-google-calendar
```

Default poll interval is 600s. For a demo, edit `~/.usrcp/google-calendar-config.json` and bump `poll_interval_s` to `60`.

```bash
# Tail 2: query the ledger
USRCP_PASSPHRASE="your-passphrase" usrcp recent --domain=calendar --limit=5
```

Now:

1. **In Google Calendar**, create a timed event (e.g. 1-minute duration) on your primary calendar with the title `usrcp demo proof`. Make sure it has both `start.dateTime` and `end.dateTime` (NOT an all-day entry — those are skipped).
2. Wait until the event end time passes (the adapter only captures meetings that have already finished — see README "What it captures").
3. Wait for the next poll tick after the event ends.
4. The poller logs `[usrcp-google-calendar] tick: captured=1 skipped=0`.
5. Re-run `usrcp recent --domain=calendar` — the event appears with:
   - `intent: event_attended`
   - `tags: ["google-calendar", "event"]`
   - `channel_id`: the Google event id
   - `detail`: summary, description, location, start/end, organizer, attendees

If both the tick log and the `usrcp recent` hit fire, capture is proven end-to-end. ✅

---

## What this does NOT prove

- **All-day events** — skipped by design (no `start.dateTime`).
- **Cancelled events / RSVP=declined** — skipped by design.
- **Secondary calendars** — only your primary calendar is polled.
- **Future events** — only events that have ended are captured ("meetings I attended", not "meetings I have scheduled").

---

## Troubleshooting

- **`invalid_grant` from Google** — the refresh token was revoked. Re-run `usrcp setup --adapter=google-calendar`.
- **Wizard exits with "master key missing"** — run via `usrcp setup --adapter=google-calendar`, not the wizard standalone. The unified entry supplies the master key.
- **Poll fires but never captures** — confirm the event has actually ended (UTC) and that it's on your primary calendar with timed start/end. All-day events and future events are filtered out.
- **OAuth consent screen rejects** — add yourself as a test user under **APIs & Services → OAuth consent screen → Test users**.
- **Passphrase needed**: if `usrcp init` was passphrase-mode, the poller needs `USRCP_PASSPHRASE` in its env.
