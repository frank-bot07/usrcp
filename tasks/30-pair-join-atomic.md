# pairJoin atomic-write fix (Codex Tier-1 #2)

Date: 2026-05-18
Branch: `feat/pair-join-atomic`

## Why

Codex's 3-day audit (logged in the PR #65 thread) flagged this as Tier-1:

> [P2] pairJoin rollback is not crash/SIGKILL safe.
> `packages/usrcp-local/src/pair.ts:413` creates the final keys/ dir, then
> `pair.ts:442` writes master.salt, master.verify, mode, private.pem,
> public.pem, and identity.json directly into their final locations
> before validation. The rollback at `pair.ts:484` only runs for
> catchable exceptions. A SIGKILL between writes leaves a partial
> identity on disk. Stage into a temp directory or use a
> .pairing-in-progress manifest that is cleaned on next start/join.

The realistic failure mode: a user runs `pairJoin`, mistypes the
passphrase, and gets a SIGINT (Ctrl+C) or SIGKILL (OOM, OS reap) in
the window after the writes started but before the snapshot/restore
rollback finished. Result: keys/ has master.salt + master.verify but
no identity.json (or vice versa), and `initializeMasterKey()` on the
next start either trusts the partial state and breaks unboot-ably, or
the user has no way to re-pair without manual file deletion.

## What changed

Two-phase rewrite of `pairJoinAfterDecrypt`:

**Phase 1: in-memory validation (no disk writes).**
- New exported helper `deriveAndVerifyMasterKey(passphrase, salt, verify) -> Buffer`
  in `encryption.ts`. Pure scrypt + HMAC verify; no disk I/O.
- pair.ts uses it to validate the bundle's passphrase against the
  bundle's salt + verify entirely in memory.
- Then decrypts `bundle.private_pem_enc` with the derived global key,
  also in memory. A bundle whose verify hash matches but whose
  encrypted private key was sealed under a different master key is now
  caught without touching disk.
- The wrong-passphrase failure mode now produces zero disk writes
  instead of six-writes-then-rollback.

**Phase 2: atomic directory commit.**
- All six key files are written into `keys-pair-staging.<rand>/` (a
  sibling of `keys/`), not into `keys/` directly.
- `commitStagingDir(stagingDir, keysDir)` then performs the atomic
  rename:
  - Fresh-pair (keysDir does not exist): single `fs.renameSync` -
    POSIX-atomic.
  - Force-overwrite (keysDir exists): two-phase rename - aside the
    existing keys/ to `keys-replaced-by-pair.<rand>/`, rename staging
    into keys/, then `rm` the aside. Restoring the original on a
    failed inner rename keeps the canonical path consistent.
- A SIGKILL anywhere mid-write leaves only the staging dir (or the
  aside) as litter; the canonical `keys/` is either fully old or
  fully new, never partial.

**Recovery sweep.**
- `sweepStaleStagingDirs(userDir)` runs at two points:
  1. At the very top of `pairJoin`, **before** the pre-flight
     `identity.json` check, so a SIGKILL-between-renames orphan is
     restored to `keys/` and the pre-flight then correctly refuses
     without `--force`.
  2. At the start of the write phase in `pairJoinAfterDecrypt`, so
     orphans from prior failed pairJoins in the same process don't
     accumulate.
- The sweep cleans `keys-pair-staging.*` directories (always safe to
  delete; never had committed identity) and recovers `keys-replaced-
  by-pair.*` (rename back to `keys/` if `keys/` is missing, else
  delete since `keys/` is already committed).

## What was deleted

- The snapshot/restore rollback machinery (`writtenPaths`,
  `priorState`, `writeAndTrack`) is gone. The atomic-commit design
  makes it unnecessary - there's nothing to roll back because nothing
  in `keys/` was touched until the final rename.
- `initializeMasterKey()` is no longer called inside pairJoin. The
  identity is committed by the rename, and the next legitimate
  `initializeMasterKey()` call (on next start) reads the committed
  state.
- `getDecryptedPrivateKeyPem()` is no longer called either; the
  in-memory `decrypt(bundle.private_pem_enc, globalKey)` does the
  same sanity check without depending on the on-disk path.

## Verification

- `(cd packages/usrcp-local && npm test)` -> 480/480 pass (was 475;
  +5 new tests in `pairJoin atomic-write safety (PR #66)`):
  - never creates the canonical keys/ dir when the passphrase is wrong
  - rejects a bundle whose private_pem_enc was sealed under a different
    master key without writing keys/
  - leaves no keys-pair-staging.* sibling after a successful pairJoin
  - sweeps stale keys-pair-staging.* dirs from a prior crashed pairJoin
  - restores keys/ from a keys-replaced-by-pair.* orphan when the prior
    pairJoin died between renames
- `(cd packages/usrcp-stream && npm test)` -> 125/125 pass (no
  regression in the downstream package).
- Pre-existing rollback tests still pass with the new mechanism:
  - "rolls back all writes when the passphrase is wrong" (the canonical
    keys dir is now never created in this scenario; `remaining = []`
    holds because `bKeysDir` does not exist).
  - "preserves existing keys on rollback when force=true and the join
    fails" (validation now fails before the rename-aside step, so the
    original keys/ is untouched).

## What this PR is NOT doing (deferred)

- Migration of any existing partial-keys directories from prior
  unbootable installs. The sweep handles forward-going recovery;
  retroactive recovery is left as a manual operation since the
  partial state is rare and depends on which files happened to be
  written before the kill signal.
- Renaming `--force` semantics. The flag still permits overwriting an
  existing identity; the only change is that the overwrite is now
  atomic instead of file-by-file.
- Touching usrcp-stream / cloud sync. Codex's Tier-1 #3 (rotate-key
  adapter-config crash resume) and Tier-2 #5 (file_offsets unbounded
  growth) are separate PRs.
