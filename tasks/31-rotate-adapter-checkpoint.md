# rotate-key adapter-config crash-resume checkpoint (Codex Tier-1 #3)

Date: 2026-05-18
Branch: `feat/rotate-key-adapter-checkpoint`

## Why

From Codex's 3-day audit:

> [P2] Adapter config re-encryption has no crash-resume checkpoint.
> rotateKey() runs onKeysReady after key files are committed, then
> clears rotation_state at keys.ts:353. If the process dies midway
> through reencryptAdapterConfigs, some configs remain encrypted under
> the old key. On restart, recovery at core.ts:54 only installs the
> pending master key and clears pending state; it does not resume
> adapter config rotation, and the old key is no longer available
> for skipped configs.

The actual data-loss path:

1. `Ledger.rotateKey` runs phases 1-3 successfully. Master.salt and
   master.verify on disk are now the NEW values; the old salt is
   GONE.
2. Phase 3.5 invokes `onKeysReady(oldKey, newKey)`, which calls
   `reencryptAdapterConfigs`. The dispatcher iterates over
   `getRotateKeyAdapterValues()` and rotates each adapter's
   on-disk config file (gmail, google-calendar, linear, discord,
   slack, telegram, github - all the OAuth/token-bearing adapters).
3. Process is SIGKILLed midway: some configs rotated, some still
   under the old key.
4. On next start, `Ledger`'s constructor sees
   `rotation_state.pending_key` still set (Phase 4 didn't run),
   installs the new master key, clears the pending state, and exits
   recovery. The half-rotated adapter configs are not touched.
5. The unrotated configs are now permanently undecryptable: the
   old salt is gone, so the old master key cannot be derived from
   the passphrase. The OAuth refresh tokens / bot tokens / API
   keys those configs hold are effectively erased.

User-visible symptom: adapters that didn't make it through the
rotation hook show "decrypt failed" on next ledger boot, and the
user has to re-run `usrcp setup --adapter=<name>` to recreate the
config. Painful and uncalibrated to user expectations.

## What changed

**Three coordinated changes:**

### 1. `rotate-adapter-configs.ts`: persistent checkpoint

`reencryptAdapterConfigs` gains optional `userDir`. When provided:

- **Write checkpoint** at `<userDir>/keys/adapter-rotation.json`
  BEFORE the per-adapter loop. Contents:
  ```jsonc
  {
    "v": 1,
    "started_at": "2026-05-18T...",
    "old_key_enc": "enc:<base64>",   // old master key sealed under
                                      // NEW global key (so recovery
                                      // can decrypt with the
                                      // post-rotation master)
    "pending": ["gmail", "linear", "discord", "..."],
    "completed": [],
    "failed": []
  }
  ```
- **Update checkpoint** after EVERY adapter (success, absent, failed,
  or unresolvable-package). The file always reflects "what's still
  in `pending` is what still needs work."
- **Delete checkpoint** after the loop completes normally.

If `userDir` is not provided, behavior is unchanged (no checkpoint
written). Tests for the pre-PR signature still pass.

### 2. `rotate-adapter-configs.ts`: `resumeAdapterRotationIfPending`

New exported function: reads `<userDir>/keys/adapter-rotation.json`,
decrypts `old_key_enc` with the current master key, calls
`reencryptAdapterConfigs` with `resumeFromCheckpoint` (which seeds
the result accumulators from the checkpoint's `completed`/`failed`
arrays so the resume returns the FULL rotation tally) and the
remaining `pending` adapters.

Defensive: if the checkpoint is malformed or `old_key_enc` cannot
be decrypted under the current master key (e.g. a second rotation
already happened and the checkpoint is orphaned), returns `null`
and leaves the file in place for operator inspection. The Ledger
constructor's caller swallows the null silently.

### 3. `Ledger` constructor: invoke recovery on every open

In `packages/usrcp-local/src/ledger/core.ts`, after the existing
`rotation_state.pending_key` recovery block, call
`resumeAdapterRotationIfPending({ userDir: getUserDir(),
currentMasterKey: this.masterKey })`. On a non-null result, write
an `adapter_rotation_recovery` audit log entry recording rotated/
absent/failed counts.

### 4. `server.ts`: thread userDir through onKeysReady

The MCP tool handler for `usrcp_rotate_key` now passes
`userDir: getUserDir()` to `reencryptAdapterConfigs` so the
checkpoint is actually written on every rotation. Without this the
recovery sweep would never have anything to resume.

## Threat model: storing the old key on disk

`old_key_enc` puts the OLD master key on disk, encrypted under the
NEW global key. Anyone who reads the new master key from disk
(dev-mode `master.key` file, or someone who knows the passphrase)
can recover the old master key. This is the same boundary as today:
the new master key has the same blast radius as the old key it
replaces, because both decrypt the same ledger data.

The checkpoint file lives in `keys/` with 0o600 alongside
`master.salt`, `master.verify`, and `private.pem`. Lifetime is
bounded: present only during a rotation window (typically <1s),
deleted on success.

## Verification

- `(cd packages/usrcp-local && npm test)` -> 489/489 pass (was
  480; +8 new tests in `rotate-adapter-configs.test.ts` + 1 new
  test in `ledger-advanced.test.ts`):
  - writes a checkpoint at start of loop, removes it on success
  - never writes a checkpoint when userDir is not provided
  - old_key_enc decrypts under the NEW global key (recovery seed)
  - records partial state in the checkpoint as adapters complete
  - resumeAdapterRotationIfPending decrypts old_key and processes
    pending adapters; returns the full pre-crash + post-crash tally
  - returns null with no checkpoint
  - returns null on an orphan checkpoint (sealed under a different
    key), leaves the file in place for inspection
  - returns null on a malformed JSON checkpoint without erasing it
  - Ledger constructor exercises the recovery sweep end-to-end and
    removes the checkpoint file
- `(cd packages/usrcp-stream && npm test)` -> 125/125 pass (no
  downstream regression).
- Em-dash sweep clean.

## What this PR is NOT doing (deferred)

- Recovery during the resume itself (e.g. SIGKILL during the resume
  re-runs the same recovery on next boot, idempotently). Tested
  indirectly by the checkpoint-update-after-each-adapter behavior.
- Compaction / log rotation of the audit_log entries. A noisy
  recovery path could accumulate `adapter_rotation_recovery`
  entries, but the count is bounded by the user's rotation
  frequency and the checkpoint only persists when a rotation
  actually crashed.
- Recovery during a passphrase change that drops the user's prior
  knowledge of the old passphrase. That scenario is handled by the
  EXISTING `pending_key` recovery: the new master key gets installed
  from `rotation_state.pending_key`, then this PR's recovery
  decrypts the checkpoint's `old_key_enc` under the new global key.
  Verified by the integration test in `ledger-advanced.test.ts`.
- Anything in usrcp-stream's parallel keying. Stream uses the same
  master key but stores its config elsewhere (sqlite-vec extension
  state); a future PR could add a parallel checkpoint if needed.

## Out of scope (separate PRs)

- Tier-2 #5 (file_offsets unbounded growth in Claude Code tailing).
- Tier-2 #1 (cloud bundle exposes owner_public_key in unauthenticated
  claim response).
- Tier-2 #4 (stream audit silent-swallow on logAudit failure).
