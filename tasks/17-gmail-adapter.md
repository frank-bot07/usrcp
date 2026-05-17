# Task 17 - Gmail capture adapter

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/usrcp-gmail` (lands after #51).

## Why this exists

Second Google adapter, immediately following the Calendar adapter
(#51). Reuses the same OAuth posture and setup flow with the only
diff being the requested scope (`gmail.readonly` vs `calendar.readonly`).

Captures messages the user SENT - mirrors the "what I did" framing
of the Calendar adapter ("events I attended"). Captures the
authored content (subject + body + recipients) for personal context
recall.

## Scope decisions (2026-05-17)

| Topic | Choice | Reason |
|---|---|---|
| Direction | Sent messages only | Highest signal-to-noise for "what was I doing" recall. Received mail is much higher volume and noisier (newsletters, automated alerts). |
| Filters at fetch time | `in:sent after:<unix> -in:drafts -in:trash -in:spam` | Limit the inbound stream at the API level rather than pulling everything and filtering client-side. |
| Body extraction | Prefer `text/plain`; strip tags from `text/html` as fallback | Most modern email has both parts; plain text is lossless. Strip-tags is lossy but adequate for recall. |
| Body length cap | 48 KiB (capture.ts BODY_MAX_CHARS) | Ledger's serialised `detail` field caps at 64 KiB; 48 KiB leaves headroom for the other fields (headers, label ids, snippet, dates). |
| Thread handling | Each message captured independently, with `thread_id` in detail + as `channel_id` | Thread reconstruction is a future PR; v0 records each message as its own event so `getRecentEventsByChannel(thread_id)` will naturally surface the thread later. |
| Idempotency | `gmail:message:<sha256(id)[:32]>` | Same hashing pattern as the Calendar adapter (#51) - Gmail message IDs are typically short but imported / forwarded mail can exceed the 100-char ledger cap. |
| Polling | 10 min default; range 60-3600s | Gmail's per-user budget is generous; 10 min is fresh enough for personal context. |
| Cursor | `internalDate` (Gmail's unix-ms timestamp of when the message landed); query uses `after:<unix-seconds>` | Stable for sent messages; cursor advances on each tick to max(captured.sent_at). |
| Stream sync | Out of scope | Ledger only, same as Calendar adapter. |

## Surface area added

**New package**: `packages/usrcp-gmail/`

- `package.json` - deps: `@googleapis/gmail` ^16.0.0, `google-auth-library` ^10.1.0 (matches what googleapis-common 8.x wants for OAuth2Client type compatibility), `usrcp-local` (file: workspace).
- `tsconfig.json` - same shape as usrcp-google-calendar.
- `src/config.ts` - read/write/load `GmailConfig`; saveLastSyncedAt debouncer (mirror of gcal).
- `src/reader.ts` - OAuth2Client setup, `validateCredentials` (via users.getProfile), `fetchSentMessages` (two-phase list + get + paginate), `normaliseMessage` (Gmail Schema$Message -> flattened `GmailActivity`, multipart body walk, text/plain preferred + HTML strip-tags fallback).
- `src/capture.ts` - pure `captureGmailActivity` with `no_id` and `no_subject_no_body` guards; body capped at 48 KiB; summary either subject or first non-empty body line truncated to 200 chars.
- `src/setup.ts` - 5-step interactive wizard (mirror of gcal's, with the scope swap).
- `src/index.ts` - polling loop, SIGINT/SIGTERM shutdown.
- `src/__tests__/capture.test.ts` - 11 tests: happy path, idempotency (incl. long-id hash), body+subject fallbacks, truncation, no_id / no_subject_no_body / mixed.
- `src/__tests__/reader.test.ts` - 8 tests for `normaliseMessage`: plain happy path, multipart with text/plain preference, HTML-only fallback, script/style stripping, missing-id null, bad-internalDate null, missing-threadId fallback to id, missing optional headers.
- `README.md` - public setup walkthrough (Google Cloud Console + OAuth Playground steps).

**Modified**:
- `.github/workflows/test.yml` - adds `usrcp-gmail` to the `node-linux` matrix + cache-dependency-path.

## Verification

```bash
cd packages/usrcp-gmail
npm install
npm run build   # prebuild builds usrcp-local first
npm test        # 19 tests
```

Manual smoke (out of scope for automated suite): real OAuth client +
real Gmail account; the poller should pick up recently-sent messages
and append `email_sent` ledger entries with full subject + body.

## Out of scope (this PR)

- Received messages.
- Thread reconstruction (we tag with `thread_id` for the follow-up).
- Attachments.
- Push via Gmail's watch endpoint.
- Encrypting the refresh token under the USRCP master key.
- Unified `usrcp setup --adapter=gmail` dispatcher in usrcp-local (#51
  fixed the dispatcher to camel-case hyphenated adapter names, so
  `gmail` already works through the existing dispatcher pattern).
