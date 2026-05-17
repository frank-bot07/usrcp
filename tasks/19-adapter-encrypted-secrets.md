# Task 19 - Encrypt adapter secrets at rest

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/adapter-encrypted-secrets` (lands after #53).

## Why this exists

Adapter configs previously stored sensitive secrets in plaintext at
mode 0600 - matching `~/.ssh/id_rsa` posture. That's defensible but
weaker than what USRCP already does for `private.pem` and the ledger
columns, which encrypt at rest under the master key derived from the
passphrase. An attacker who reads the disk without unlocking the
passphrase already cannot decrypt the ledger or sign as the user; the
adapter configs were the only secrets they could still pull and
replay (refresh tokens grant `gmail.readonly` / `calendar.readonly`;
the Linear API key grants Linear read access).

This PR closes that gap for the three adapters whose secret model is
shaped right for it: usrcp-google-calendar, usrcp-gmail, and
usrcp-linear. Other adapters (Discord, Slack, Telegram, iMessage)
each have their own config layouts and can be migrated in follow-up
PRs using the same pattern.

## What changed

Sensitive fields now ship to disk as `enc:<base64>` ciphertext under
the global encryption key (HKDF-derived from the master key), same
envelope shape used by `private.pem` and the ledger. Per adapter:

| Adapter | Encrypted fields |
|---|---|
| usrcp-google-calendar | `oauth_client_secret`, `refresh_token` |
| usrcp-gmail | `oauth_client_secret`, `refresh_token` |
| usrcp-linear | `linear_api_key` |

Non-sensitive fields (`oauth_client_id`, `domain`, `poll_interval_s`,
`allowlisted_team_ids`, `last_synced_at`) stay plaintext.

## Master-key plumbing

The dispatcher in `usrcp-local/src/setup.ts` now acquires the master
key once and passes it to adapter setup wizards as `{ masterKey }`:

- **Full wizard** (`usrcp setup` with no `--adapter`): `ensureLedger`
  returns `{ masterKey, passphrase }`; the master key is threaded to
  `runAdapterSetups` via a closure setupFn. Existing-ledger users
  are prompted for their passphrase (or `USRCP_PASSPHRASE` is
  honored).
- **Standalone `--adapter` path**: `acquireMasterKeyForStandaloneAdapter`
  reads `USRCP_PASSPHRASE` in passphrase mode, fails fast with a
  clear error if neither env nor disk has what we need.

Adapter daemons (`usrcp-gmail`, `usrcp-google-calendar`,
`usrcp-linear`) call `ledger.getMasterKey()` after constructing the
Ledger and pass that key into `loadConfig`. The `saveLastSyncedAt`
debounce was extended to also stash the master key so the next flush
re-encrypts the (decrypted) on-disk config when it writes the new
cursor.

## Legacy plaintext compat

A user upgrading across this PR keeps their existing config: the
load path checks for the `enc:` prefix on each sensitive field and
falls through to plaintext if absent. The next save (e.g. when the
poller advances the cursor) writes the encrypted envelope. Tests
cover the migration end-to-end.

## Scope decisions (2026-05-17)

| Topic | Choice | Reason |
|---|---|---|
| Three adapters this PR | gcal, gmail, linear | All three were touched recently; the encryption pattern is identical across them. |
| Other adapters | Out of scope | Discord/Slack/Telegram/iMessage have different config layouts and each deserves its own PR. |
| Decryption failure | `process.exit(1)` with a clear message | Same posture as malformed-JSON / missing-fields. A wrong-passphrase user wants the failure loud, not silent. |
| Legacy migration | Read-as-plaintext, write-as-encrypted | Zero user-visible churn; no migration command needed. |
| `usrcp setup --adapter=...` without passphrase | Fail fast with a clear "set USRCP_PASSPHRASE" message | A silent skip would leave the user with a half-configured adapter; better to refuse early. |

## Surface area

- `packages/usrcp-local/src/setup.ts`: `callAdapterSetup` now passes
  `{ masterKey }`. `ensureLedger` returns the master key.
  `runSetup` threads it through both the full-wizard and
  `--adapter` paths. New `acquireMasterKeyForStandaloneAdapter`
  helper. New `resolveExistingMasterKey` for the existing-ledger
  branches.
- Per adapter: `src/config.ts` adds `encryptSecret` /
  `maybeDecryptSecret` helpers; `writeXxxConfig(cfg, masterKey)`
  encrypts sensitive fields; `loadConfig(masterKey)` decrypts;
  `saveLastSyncedAt(ts, masterKey)` stashes the key for the flush;
  `flushLastSyncedAt` decrypts existing-on-disk before re-encrypting.
- Per adapter: `src/setup.ts` wizard signature is
  `({ masterKey }: { masterKey?: Buffer })`; fails fast if missing.
- Per adapter: `src/index.ts` daemon gets `masterKey` from
  `ledger.getMasterKey()` after the Ledger is initialised; passes to
  every config call site.
- New tests:
  - `packages/usrcp-google-calendar/src/__tests__/config.test.ts` (5 tests)
  - `packages/usrcp-gmail/src/__tests__/config.test.ts` (5 tests)
  - `packages/usrcp-linear/src/__tests__/config.test.ts`: existing 38
    tests updated to pass `masterKey`; 2 new tests for legacy
    auto-migration + wrong-key decrypt error.

## Verification

```bash
(cd packages/usrcp-cloud  && npm test)                    # 75 unchanged
(cd packages/usrcp-local  && npm test)                    # 413 unchanged
(cd packages/usrcp-stream && npm test)                    # 107 unchanged
(cd packages/usrcp-google-calendar && npm test)           # 21 (+5)
(cd packages/usrcp-gmail && npm test)                     # 29 (+5)
(cd packages/usrcp-linear && npm test)                    # 39 (+2; one pre-existing capture.test.ts NODE_MODULE_VERSION failure unrelated to this PR)
```

## Out of scope

- Discord / Slack / Telegram / iMessage adapter configs.
- Re-encryption on master-key rotation (today, rotating the master
  key via `usrcp rotate-key` would invalidate every adapter config
  because the `enc:` envelopes were keyed to the OLD master. A
  follow-up PR could iterate adapter configs during rotation and
  re-encrypt under the new key).
- Encrypting the `last_synced_at` cursor itself (not a secret; a
  passive observer learns approximately when you last polled
  whether it's encrypted or not).
