# usrcp-gmail

Capture-only Gmail adapter for USRCP. Polls the configured user's
Gmail for messages they sent and appends them to the local ledger
as `email_sent` entries.

The cloud sees nothing from this adapter; ledger writes only. The
ledger encrypts at rest under the same master key as the rest of
USRCP.

## What it captures

- **Sent messages only.** Mirrors the "what I did" framing of the
  Google Calendar adapter (#51): we record what the user wrote, not
  what landed in their inbox.
- Skipped: drafts, trash, spam.
- For each message: subject, body (text preferred, HTML stripped
  fallback), snippet, from / to / cc / bcc, Date header, label IDs,
  thread id, `internalDate` cursor.

Each ledger entry:
- `domain`: configurable (default `email`)
- `intent`: `email_sent`
- `outcome`: `success`
- `detail`: full message metadata (body capped at 48 KiB so the
  serialised detail stays under the ledger's 64 KiB envelope cap).
- `tags`: `["gmail", "email", "sent"]`
- `channel_id`: Gmail `threadId` (so `getRecentEventsByChannel`
  returns the thread once we capture replies in a future PR).
- Idempotency key: `gmail:message:<sha256(id)[:32]>` (re-running the
  poller is a no-op; long imported-message IDs are handled).

## Setup

Same OAuth posture as `usrcp-google-calendar`: Google has no
"personal API key" shortcut for user mail data, so the wizard takes
three secrets the user gets out-of-band.

### 1. Create the OAuth client (one-time)

1. [console.cloud.google.com](https://console.cloud.google.com) ->
   create / select a project.
2. **APIs & Services > Library**: enable **Gmail API**.
3. **APIs & Services > OAuth consent screen**: External, fill the
   required fields, add your email as a test user.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**:
   choose **Desktop app**. Copy the **client ID** and **client secret**.

### 2. Run the wizard

```bash
cd packages/usrcp-gmail
npm install
npm run build

usrcp setup --adapter=gmail
```

The wizard prompts for `client_id` + `client_secret` and then asks
whether to authorise via browser (default Yes). The browser flow
opens a localhost listener, prints the Google sign-in URL, captures
the redirect, and persists the refresh token automatically; no copy /
paste from the OAuth Playground.

If you can't open a browser from this machine (remote shell, CI,
etc.), answer "no" and the wizard falls back to the manual
OAuth-Playground path:

1. Visit [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. Click the gear icon, tick **Use your own OAuth credentials**, paste
   the client ID + secret.
3. In the left panel, scroll to **Gmail API v1** and tick
   `https://www.googleapis.com/auth/gmail.readonly`.
4. **Authorize APIs** -> sign in -> **Exchange authorization code for tokens**.
5. Copy the `refresh_token` and paste it into the wizard.

The wizard validates the credentials against `users.getProfile`
before persisting, so a bad value fails fast.

## Run

```bash
usrcp-gmail
# or: USRCP_PASSPHRASE=<pp> usrcp-gmail
```

The poller logs each tick that captured or skipped any messages.

## Config

Stored at `~/.usrcp/gmail-config.json` (mode 0600):

| Field | Type | Notes |
|---|---|---|
| `oauth_client_id` | string | From step 1. |
| `oauth_client_secret` | string | From step 1. Plaintext on disk; treat like `~/.ssh/id_rsa`. |
| `refresh_token` | string | From step 2. Same posture. |
| `domain` | string | USRCP domain to write events under. |
| `poll_interval_s` | number | Seconds; 60-3600. Default 600 (10 min). |
| `last_synced_at` | string | ISO; managed by the poller. |

## What's out of scope (v0)

- Received messages (replies, inbound mail). v0 captures only what
  the user authored.
- Thread reconstruction across messages. We tag each message with its
  `thread_id` so a follow-up PR can group them; v0 records each
  message independently.
- Attachment metadata or content.
- Push notifications via Gmail's watch endpoint (we poll - works
  behind NAT on a laptop, no public URL needed).
- Encrypting the refresh token under the USRCP master key (matches
  the Linear / Google Calendar posture: file is mode 0600 on the
  user's machine, same as `~/.ssh/id_rsa`).
- Stream sync (no `stream_events` entries; ledger only).
