# Task 16 - Google Calendar capture adapter

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/usrcp-google-calendar` (lands after #50).

## Why this exists

After six PRs of safety / auth / pairing work, the user picked a
forward-motion adapter PR to extend the marketplace direction. Google
Calendar is the first Google-surface adapter and the second
non-conversational adapter (Linear was the first; everything else is
chat / messaging).

Captures past calendar events the user attended as `event_attended`
ledger entries, with one entry per event-instance. The cloud sees
nothing from this adapter; the writes go only to the local ledger.

## Scope decisions (2026-05-17)

| Topic | Choice | Reason |
|---|---|---|
| Surface | Google Calendar | Most universally-useful first Google adapter. Bounded volume per user (calendar events are 10s/day, not 100s like Gmail). Clean schema. |
| Calendar scope | Primary calendar only | Personal context first; secondary calendars (shared team calendars, etc.) can come in v1. |
| Event types | `event_attended` only (events that have ended) | Captures the "I had a meeting with X" timeline signal. `event_created` ("I scheduled X") is transactional and out of scope. |
| Filters applied at capture | cancelled / all-day / user-declined | A declined event isn't an "attended" event; cancelled ones are noise; all-day entries are usually birthdays / OOO which clutter the timeline. |
| Auth | OAuth refresh token (user-provided) | Google has no personal-API-key shortcut. The wizard takes client_id + client_secret + refresh_token from external steps (Google Cloud Console + OAuth Playground), documented in the package README. Matches the manual-setup posture of usrcp-linear. |
| Token storage | Plaintext at `~/.usrcp/google-calendar-config.json` (mode 0600) | Same posture as the Linear API key; the file is the user's responsibility (treat like `~/.ssh/id_rsa`). The USRCP master key is out of scope for adapter configs by design. |
| Poll interval | 5 min default; range 60-3600s | Google Calendar's read quota is generous; 5 min is fresh enough for personal context without burning quota. |
| Cursor | `endedAfter` ISO timestamp; advance to max(observed_end) on each tick | Events that have already ended cannot be pushed back into the window unless edited; if they are, the idempotency key (`gcal:event:<id>`) dedupes the re-capture. |
| Stream sync | Out of scope | This PR writes ledger only. A future PR could add stream events (one per attendee?), but the value-per-LOC isn't there yet. |
| Webhook push | Out of scope | Personal deployments run on laptops behind NAT; polling is fine. |

## Surface area added

**New package**: `packages/usrcp-google-calendar/`

- `package.json` - deps: `@googleapis/calendar`, `google-auth-library`, `usrcp-local` (file: workspace).
- `tsconfig.json` - copy of the Linear adapter config.
- `src/config.ts` - read/write/load `GoogleCalendarConfig`; saveLastSyncedAt debouncer.
- `src/reader.ts` - OAuth2Client setup, `validateCredentials` (used by the wizard), `fetchPastEvents` (events.list with pagination + the cancelled/all-day/declined filter), `normaliseEvent` (Calendar event -> flattened `CalendarActivity`).
- `src/capture.ts` - pure `captureCalendarActivity(ledger, activity, config)` mirroring usrcp-linear's testable shape.
- `src/setup.ts` - 5-step interactive wizard.
- `src/index.ts` - polling loop with recursive setTimeout; SIGINT/SIGTERM shutdown.
- `src/__tests__/capture.test.ts` - 8 tests: happy path, idempotency, summary truncation, future_event guard, no_title + whitespace, no_id.
- `src/__tests__/reader.test.ts` - 6 tests for `normaliseEvent`: happy path, drop cancelled, drop all-day, drop declined, keep accepted/tentative/solo, fallback for missing summary.
- `README.md` - public-facing setup instructions (OAuth playground walkthrough).

**Modified**:
- `.github/workflows/test.yml` - added `usrcp-google-calendar` to the
  `node-linux` matrix and to the cache-dependency-path list. CI runs
  the new test file alongside every other package.

## Verification

```bash
cd packages/usrcp-google-calendar
npm install
npm run build   # uses prebuild to build usrcp-local first
npm test        # 14 tests
```

Manual smoke (out of scope for the automated suite): set up a real
OAuth client, run `usrcp setup --adapter=google-calendar`, then
`usrcp-google-calendar`. Verify the poller picks up a recent past
meeting and appends an `event_attended` entry to the ledger.

## Out of scope (this PR)

- Secondary calendars / multi-calendar selection.
- Stream sync (`stream_events` per attendee, thread reconstruction).
- Reverse direction (writing back to Calendar; e.g. `@usrcp` notes
  becoming calendar events).
- Capturing future / scheduled events (only past attended events).
- `usrcp setup --adapter=google-calendar` dispatcher in usrcp-local
  (the wizard is exported from this package; wiring it into the
  unified `usrcp setup` is a follow-up).
- Refresh-token rotation on revocation.

## Open follow-ups

1. Add a thin shim in `usrcp-local/src/setup.ts` so `usrcp setup
   --adapter=google-calendar` calls into this package's `runGoogleCalendarSetup`.
2. Build an interactive OAuth-Playground replacement (a one-time
   `usrcp-google-calendar oauth` subcommand that opens a localhost
   redirect listener) so users don't have to leave the terminal.
3. Encrypt the refresh token at rest under the USRCP master key,
   matching what the pairing private.pem does.
