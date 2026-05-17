# Re-encrypt adapter configs during `usrcp_rotate_key`

Date: 2026-05-17
Branch: `feat/rotate-reencrypts-adapter-configs`
Follow-on to #54 + #55.

## Why

After #54 and #55, six adapter configs on disk
(`~/.usrcp/<adapter>-config.json` for gcal, gmail, linear, discord,
slack, telegram) encrypt their OAuth refresh tokens / bot tokens /
API keys under the USRCP global encryption key, which is derived
from the master key via HKDF.

`Ledger.rotateKey()` rotates the master key but doesn't touch those
external files. After rotation, every encrypted adapter config
becomes undecryptable on the next daemon boot: the AES-GCM auth tag
fails because the derived global key changed. The user is stuck
with their adapters broken until they re-run setup for each one.

`#54`'s decision doc already listed this as a follow-up:

> Re-encryption on master-key rotation (today, rotating the master
> key via `usrcp rotate-key` would invalidate every adapter config
> because the `enc:` envelopes were keyed to the OLD master. A
> follow-up PR could iterate adapter configs during rotation and
> re-encrypt under the new key).

This PR is that follow-up.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where does the integration hook live? | Pluggable callback on `rotateKey({ onKeysReady })` | The Ledger doesn't (and shouldn't) know about adapter packages. The hook keeps adapter awareness in the caller (server.ts wires the dispatcher). |
| When during rotation does the hook fire? | After `commitKeyRotation` writes the new key files; before in-memory `masterKey` is swapped and pending state cleared | Both keys are still live so the dispatcher can decrypt with the old and encrypt with the new. Failure here doesn't roll back the master key (already on disk) but does prevent us from clearing `pending_key`, so the failure mode is documented and recoverable. |
| What if an adapter throws? | Log + continue. Track in `failed[]`. | One bad config (corrupt JSON, missing field, decrypt mismatch) shouldn't poison rotation for the other five adapters. The user gets a list of which adapters need manual `usrcp setup --adapter=<name>`. |
| Per-adapter helper signature | `reencryptConfigUnderNewKey(oldKey, newKey): "absent" \| "rotated"` (sync, throws on error) | Bypasses `loadConfig` (which calls `process.exit`, bad during rotation) and `writeXxxConfig` (which truncates non-atomically). Lives inside each adapter package so secrecy knowledge stays per-adapter (per [[project_usrcp_adapters_as_addons]]). |
| Per-file atomicity | Tmp file + rename inside each adapter helper | Each adapter is either fully old-key or fully new-key on disk. No "half-rewritten" config on power loss / crash during rotation. |
| Adapter loading mechanism | `require()` from `packages/usrcp-<name>/dist/config.js`, same pattern as `setup.ts` | Sync require keeps the hook sync, lets us avoid making `rotateKey` async. |

## Surface area

**New (1):**
- `packages/usrcp-local/src/rotate-adapter-configs.ts` - the
  dispatcher. Exports `reencryptAdapterConfigs({ oldKey, newKey })`
  and `ADAPTERS_WITH_ENCRYPTED_CONFIG`.

**Modified ledger / server:**
- `packages/usrcp-local/src/ledger/keys.ts` - `rotateKey` now
  accepts `opts.onKeysReady?: (oldKey, newKey) => void`. Hook fires
  after `commitKeyRotation`, before in-memory swap. Throws inside
  the hook are caught + warned, rotation continues.
- `packages/usrcp-local/src/server.ts` - the MCP tool
  `usrcp_rotate_key` wires the hook to the dispatcher and surfaces
  `adapter_configs: { rotated, absent, failed }` on the response.

**Per adapter (new export in each):**
- `packages/usrcp-discord/src/config.ts`
- `packages/usrcp-slack/src/config.ts`
- `packages/usrcp-telegram/src/config.ts`
- `packages/usrcp-google-calendar/src/config.ts`
- `packages/usrcp-gmail/src/config.ts`
- `packages/usrcp-linear/src/config.ts`

Each gains a `reencryptConfigUnderNewKey(oldKey, newKey)` that:
- Returns `"absent"` if no config file exists.
- Reads the raw on-disk shape (bypassing the exit-on-error `loadConfig`).
- Decrypts the sensitive fields with the old key (passes plaintext-on-disk
  through verbatim - same legacy migration shape as
  [[feedback_usrcp_adapter_setup_return_type]]).
- Re-encrypts under the new key.
- Writes atomically: `<file>.rotate-tmp.<pid>.<ts>` -> `chmod 0600` -> `rename`.
- Returns `"rotated"`.

**Tests:**
- 6 new tests per adapter (36 across 6 adapter packages) covering:
  round-trip rotation, legacy plaintext migration, mode 0600 preserved,
  missing-field error, no tmp-file leftovers, only-new-key-can-decrypt.
- 7 new tests in `usrcp-local/src/__tests__/rotate-adapter-configs.test.ts`
  for the dispatcher (partitioning, missing modules silently skipped,
  failures isolated to one adapter, missing exports flagged).
- 2 new tests in `usrcp-local/src/__tests__/ledger.test.ts` for the
  `onKeysReady` hook contract (timing of old/new key visibility +
  non-fatal throw semantics).

## Verification

- `(cd packages/usrcp-discord && npm test)` -> 45/45
- `(cd packages/usrcp-slack && npm test)` -> 52/52
- `(cd packages/usrcp-telegram && npm test)` -> 53/53
- `(cd packages/usrcp-google-calendar && npm test)` -> 33/33
- `(cd packages/usrcp-gmail && npm test)` -> 41/41
- `(cd packages/usrcp-linear && npm test)` -> 51/51 (+ 1 pre-existing NODE_MODULE_VERSION)
- `(cd packages/usrcp-local && npm test)` -> 422/422

## Failure modes considered

1. **Adapter throws inside its helper** - dispatcher catches,
   adds to `failed[]`, continues. Other adapters still rotate.
2. **Hook throws (dispatcher itself crashes)** - `rotateKey` catches,
   warns, clears pending state, rotation still completes.
   User sees no `adapter_configs` field; affected adapters need
   manual `usrcp setup --adapter=<name>`.
3. **Adapter package not installed** - dispatcher silently skips
   (no module file present).
4. **Rename fails mid-write** - tmp file is left behind, the original
   config is untouched, the adapter shows up in `failed[]`.
   (Tmp-file cleanup on failure is best-effort; orphan files in
   `.rotate-tmp.*` form are an annoyance but harmless.)

## Out of scope

- Tmp-file orphan cleanup on subsequent boots. Could grep
  `.rotate-tmp.*` and unlink. Not done; orphans are tiny and harmless.
- Identity rotation (`usrcp rotate-identity`) doesn't rotate the
  master key, so adapter configs aren't affected by it. No change
  to that flow.
