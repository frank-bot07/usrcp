# Task 11 - Multi-device identity pairing flow

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/multi-device-pairing` (lands after #44 cloud sync).

## Why this exists

Cloud sync (`usrcp sync push|pull`, `usrcp-stream` cloud sync) routes
events by `user_public_key`. Two devices that want to behave as the
same user must share the same Ed25519 identity. Until this PR the only
way to do that was to copy `~/.usrcp/users/<slug>/keys/` by hand -
friction-heavy and easy to get wrong.

This PR adds a cloud-mediated pairing flow. Device A produces an
8-digit code and uploads a client-encrypted bundle; device B fetches
the bundle by code, decrypts locally, writes the four key files, and
re-derives the master key from the user's passphrase as the final
sanity check.

## Scope decisions (2026-05-15)

| Topic | Choice | Reason |
|---|---|---|
| Transport | Cloud-mediated via `/v1/pairing/*` | Reuses the same Postgres + Fastify rig as cloud sync. Out-of-band paste / mDNS would be a parallel feature; pick the simplest one first. |
| Code | 8 numeric digits, displayed `1234-5678` | Short enough to read aloud or type; long enough that 5-attempt cap + 10-min TTL makes online brute-force impractical. |
| KDF | `scrypt(code, FIXED_PAIRING_SALT, N=131072)` | Same scrypt parameters as the passphrase KDF - slows offline brute-force on a stolen ciphertext. |
| Bundle contents | `master.salt` + `master.verify` + `identity.json` + encrypted `private.pem` | Device B can derive the master key from the passphrase alone, then decrypt the private key. Public.pem is reconstructed from `identity.public_key`. |
| Surface | CLI only (`usrcp pair init|join|status|cancel`) | One-shot setup. MCP tools would imply repeated use, which this is not. |
| Default TTL | 10 minutes (cap 30) | Bounds the cloud-side exposure window for offline cracking. |
| Attempt cap | 5 GETs per `/v1/pairing/claim/:code` | After 5 wrong code attempts the bundle row is locked and pruned. Device A must re-init. |

## Threat model

The server sees:

- The 8-digit code, stored verbatim as the primary key on the row.
- The Ed25519-signed POST from device A (proves which user owns the bundle).
- The encrypted bundle blob.

It does **not** see the passphrase or the bundle plaintext, and the
server code never calls the scrypt KDF.

**The cloud holds the decryption material during the TTL.** The bundle
is encrypted under `scrypt(code, FIXED_PAIRING_SALT, N=131072)`, and
the cloud stores `code` alongside `encrypted_bundle`. Anyone with read
access to the row (operator, log that captured the POST body, DB dump)
can derive the key offline in a single scrypt invocation. This is not
a brute-force problem; the code IS the key. The 5-attempts-per-code
cap protects against an *external* attacker probing the public GET
endpoint - it does nothing against the cloud itself.

**Residual risk we accept:** for the 10-minute TTL window, the cloud
provider is trusted. If you don't trust your cloud provider for that
window, use the manual `keys/` copy fallback over SSH/USB. This
trade-off is called out in both READMEs.

### Tier-2 design options (NOT in this PR)

The current design optimises for the "8 digits read aloud" UX. Two
alternatives would close the cloud-holds-the-key gap at a UX cost:

| Option | Mechanism | UX cost |
|---|---|---|
| Out-of-band secret | Random 128-bit secret stays between devices; cloud sees `(code, ciphertext)` where ciphertext is encrypted under `HKDF(code || secret)`. Code is the lookup; secret is the actual key. | Code becomes long enough to embed the secret (e.g., 24+ base32 chars) - not voiceable. QR code becomes the natural transport. |
| Hashed lookup key | Server stores `hash(code)` as the PK; raw code never reaches the server. Same 8-digit UX preserved. | Only protects against passive log dumps; an active malicious server can still observe codes in transit during the POST, so the protection is weaker than option 1. |

If/when Chad decides the trust-the-cloud window is unacceptable, option 1
is the right path. The current PR documents the trade-off honestly and
leaves both options open.

Specifically NOT in this PR:

- Out-of-band paste transport (no cloud).
- LAN-only / mDNS pairing.
- QR-code rendering or scanning.
- Identity rotation / revocation.
- Per-device subkeys (would be a much larger change - needs a
  device-list / device-revoke management surface and re-encryption of
  every per-domain key under a per-device wrap).

## Surface area added

**New (server):**
- `pairing_bundles` table (schema migration).
- `packages/usrcp-cloud/src/pairing.ts` - Fastify plugin with the four
  endpoints; `prunePairingBundles(db)` helper rides the existing
  5-minute `setInterval`.

**New (client):**
- `packages/usrcp-local/src/pair.ts` - `pairInit / pairJoin /
  pairStatus / pairCancel` plus `formatCode` and four typed error
  classes (`InvalidPairingCode`, `WrongPassphrase`, `PairingExpired`,
  `PairingLocked`).
- `FIXED_PAIRING_SALT` + `deriveFromPairingCode` exported from
  `packages/usrcp-local/src/encryption.ts`.
- `usrcp pair init|join|status|cancel` CLI subcommand in
  `packages/usrcp-local/src/index.ts`.

**Tests:**
- `packages/usrcp-cloud/src/__tests__/pairing-routes.test.ts` - 14
  tests covering auth, code validation, ON-CONFLICT same-owner
  replacement, cross-user collision (409), claim attempt counter, 429
  lockout, list scope, owner-only delete, prune loop, migration.
- `packages/usrcp-local/src/__tests__/pair.test.ts` - 11 tests with a
  stubbed `fetch` covering round-trip, collision retry, the six
  written files, rollback on wrong passphrase, force-overwrite refusal,
  invalid-code paths, malformed-code short-circuit, status/cancel.
- `packages/usrcp-stream/src/__tests__/pair-integration.test.ts` - 3
  tests with in-process Fastify + pg-mem covering byte-identical
  `identity.json` across devices, no-plaintext-on-server assertion,
  and the post-join authenticated request landing under the original
  user_public_key.

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)   # 54 tests
(cd packages/usrcp-local  && npm run build && npm test)   # 383 tests
(cd packages/usrcp-stream && npm test)                    # 106 tests
```

All three suites green as of the branch tip. The integration test in
`usrcp-stream` is the only place that exercises the full A → cloud → B
flow; it asserts (a) device B's `identity.json` is byte-identical to
device A's, (b) the cloud's `pairing_bundles.encrypted_bundle` does
not contain the `user_id` or `BEGIN PRIVATE KEY` substrings, and (c)
device B's signed request to `/v1/state` succeeds under device A's
public key.
