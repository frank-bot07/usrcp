# usrcp-google-calendar

Capture-only Google Calendar adapter for USRCP. Polls the configured
user's primary calendar for past events they attended and appends
them to the local ledger as `event_attended` entries.

The cloud sees nothing from this adapter; it writes only to the
local ledger (which encrypts at rest under the same master key as
the rest of USRCP).

## What it captures

- Events on the **primary** calendar with both a `start.dateTime` and
  an `end.dateTime` (i.e., timed events; all-day entries are skipped).
- Only after the event has **ended** - we capture meetings the user
  actually attended, not future appointments.
- Skipped: cancelled events; events the user RSVP'd `declined`.

Each ledger entry has:
- `domain`: configurable (default `calendar`)
- `intent`: `event_attended`
- `outcome`: `success`
- `detail`: full event metadata - id, summary, description, location,
  url, start, end, organizer email, attendee emails, created/updated.
- `tags`: `["google-calendar", "event"]`
- `channel_id`: the Google event id (for `getRecentEventsByChannel`).
- Idempotency key: `gcal:event:<id>` (re-running the poller is safe).

## Setup

Google requires a real OAuth client; there is no "personal API key"
shortcut for user calendar data. Setup is a one-time three-secret
prompt.

### 1. Create the OAuth client (one-time)

1. Go to [console.cloud.google.com](https://console.cloud.google.com),
   create a project (or reuse one).
2. **APIs & Services > Library**: enable **Google Calendar API**.
3. **APIs & Services > OAuth consent screen**: set up the consent
   screen (External, fill the required fields, add your email as a
   test user).
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**:
   choose **Desktop app**. Copy the resulting **client ID** and
   **client secret**.

### 2. Get a refresh token

1. Visit [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. Click the gear icon (top right). Tick **Use your own OAuth credentials**
   and paste your client ID + secret.
3. In the left panel, scroll to **Google Calendar API v3** and tick
   `https://www.googleapis.com/auth/calendar.readonly`.
4. Click **Authorize APIs**, complete the Google sign-in, then
   **Exchange authorization code for tokens**.
5. Copy the `refresh_token` from the response.

### 3. Run the wizard

```bash
cd packages/usrcp-google-calendar
npm install
npm run build

usrcp setup --adapter=google-calendar
# prompts for client_id, client_secret, refresh_token, poll interval,
# and the USRCP domain to write under.
```

The wizard validates the credentials against the Calendar API before
persisting, so a wrong value fails fast.

## Run

```bash
usrcp-google-calendar
# or: USRCP_PASSPHRASE=<pp> usrcp-google-calendar
```

The poller logs each tick that captured or skipped any events.

## Config

Stored at `~/.usrcp/google-calendar-config.json` (mode 0600):

| Field | Type | Notes |
|---|---|---|
| `oauth_client_id` | string | From step 1. |
| `oauth_client_secret` | string | From step 1. Plaintext on disk; treat like `~/.ssh/id_rsa`. |
| `refresh_token` | string | From step 2. Same posture. |
| `domain` | string | USRCP domain to write events under. |
| `poll_interval_s` | number | Seconds; 60-3600. Default 300 (5 min). |
| `last_synced_at` | string | ISO; managed by the poller. |

## What's out of scope (v0)

- Secondary calendars (only primary).
- Stream sync (no `stream_events` entries; ledger only).
- Capturing future events (no "I scheduled X" entries).
- Recurring-event masters (we capture each instance individually via
  `singleEvents=true`).
- Webhook push (we poll - works behind NAT on a laptop).
- Storing event bodies encrypted-at-rest with the USRCP master key
  (matches Linear's posture: config is plaintext-on-disk, mode 0600,
  same as `~/.ssh/id_rsa`).
