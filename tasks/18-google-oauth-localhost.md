# Task 18 - Localhost OAuth flow for Google adapters

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/google-oauth-localhost` (lands after #52).

## Why this exists

#51 (google-calendar) and #52 (gmail) shipped with a manual OAuth
flow: the user had to leave the terminal, visit Google's OAuth
Playground in a browser, paste their client_id + client_secret
there, walk through Google sign-in, exchange the auth code, copy the
refresh_token from a JSON blob, and paste it back into the wizard.

That's a real-time friction tax of ~5 minutes per setup, and easy to
fumble (paste the wrong field, miss the "Force prompt: consent"
toggle and not get a refresh_token, etc.).

This PR adds a localhost-redirect OAuth flow shared by both adapters
(and any future Google adapter). The wizard spins up a free-port
HTTP listener, builds the Google authorize URL with that port as the
redirect, prints the URL for the user to open in any local browser,
catches the redirect, exchanges the code for tokens, and persists
the refresh_token. The whole thing takes ~15 seconds and never
leaves the terminal.

## Surface area added / changed

**New:**
- `packages/usrcp-local/src/adapters/google-oauth/index.ts` -
  `runLocalhostOauthFlow({ buildAuthUrl, exchangeCode, timeoutMs,
  log })`. Generic over the OAuth provider; the adapter caller plugs
  in its own google-auth-library `OAuth2Client` via the two
  callbacks. usrcp-local stays Google-free at the dep level.
- `packages/usrcp-local/src/__tests__/google-oauth.test.ts` - 9
  tests covering the redirect parser + 5 end-to-end flows driven
  by a fake HTTP redirect into the running listener (success path,
  ?error=, missing code, missing refresh_token, timeout).

**Modified:**
- `packages/usrcp-google-calendar/src/setup.ts` - Step 3 now leads
  with `Authorise via browser on this machine? [Y/n]`. On Yes,
  drives `runLocalhostOauthFlow` with the gcal `calendar.readonly`
  scope. On No (or non-TTY), falls back to the existing manual
  refresh_token prompt.
- `packages/usrcp-gmail/src/setup.ts` - same shape with the gmail
  `gmail.readonly` scope.
- `packages/usrcp-google-calendar/README.md` and `packages/usrcp-gmail/README.md` -
  lead with the browser flow, keep the OAuth-Playground fallback as
  the second option (for remote shell / CI users).

## Scope decisions (2026-05-17)

| Topic | Choice | Reason |
|---|---|---|
| Where the shared helper lives | `usrcp-local/src/adapters/google-oauth/` | Adapters import via `usrcp-local/dist/...` - same pattern they already use for the Ledger / encryption / setup-dispatcher. |
| Google deps in usrcp-local | None | Helper is provider-generic via `buildAuthUrl` + `exchangeCode` callbacks. The adapter packages already depend on `google-auth-library`; that's where the Google-specific OAuth2Client lives. |
| Redirect URI | `http://127.0.0.1:<picked-port>/oauth2callback` | Google's Desktop-app OAuth clients accept any 127.0.0.1 port without pre-registration, so we pick a free port at runtime (no port collision on the user's machine, no config needed). |
| Browser opening | Print the URL; user clicks | Avoids a new dependency (no `open` package). Most terminals auto-link URLs. The user pasting the URL into their browser is one extra step but removes a transitive dep. |
| Timeout | 5 minutes | Enough headroom for "I have to log in to Google fresh." Configurable via `timeoutMs`. |
| Browser-flow default | On (Yes) | The whole point of the PR is to make the easy path the default. `--reset-config` + a fresh setup also default to Yes. |
| Manual fallback | Kept | Remote shells, CI runs, headless servers, and users who already have a working refresh_token from elsewhere all need a non-browser path. |

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)   # 75 unchanged
(cd packages/usrcp-local  && npm run build && npm test)   # 410 (+9)
(cd packages/usrcp-stream && npm run build && npm test)   # 107 unchanged
(cd packages/usrcp-google-calendar && npm test)           # 16 unchanged
(cd packages/usrcp-gmail && npm test)                     # 24 unchanged
```

Manual smoke (out of scope for the automated suite): real OAuth
client; run `usrcp setup --adapter=google-calendar` (or `--adapter=gmail`)
on a desktop / laptop with a default browser; complete the Google
sign-in; the wizard should print the authorisation URL, wait, capture
the redirect, validate against the Calendar / Gmail API, and persist
the refresh token without any further user input beyond the
browser-side consent.

## Out of scope (this PR)

- Auto-open the browser (would need an `open`-style dep).
- A standalone `usrcp-google-calendar oauth` / `usrcp-gmail oauth`
  subcommand for re-authorising without running the full wizard
  (the existing `--reset-config` already covers this).
- Encrypting the refresh_token at rest under the USRCP master key
  (matches the Linear / current Google posture; tracked in
  tasks/16 + tasks/17).
- Localhost auto-refresh on token expiry (the adapters already
  refresh access tokens via google-auth-library on every poll).
