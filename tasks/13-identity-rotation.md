# Task 13 - Identity rotation / revocation

**Repo:** `/Users/frankbot/usrcp/`.
**Branch:** `feat/identity-rotation` (lands after #45 / #46 / #47).

## Why this exists

A user may lose a device, suspect their passphrase was captured, or
need to invalidate an old key for any other reason. Before this PR,
the only recovery was to wipe the user dir on every device and start
fresh - losing all cloud-stored data in the process.

This PR adds atomic identity rotation: generate a fresh Ed25519
keypair, move every per-user row in the cloud from the old key to the
new key, and permanently revoke the old key so it cannot be reused
even if the attacker still holds the private material.

## Protocol

```
POST /v1/rotate-identity
Headers:    X-USRCP-PublicKey: <K1 PEM, base64>   <- OLD key
            X-USRCP-Timestamp / Nonce / Signature   <- signed by K1
Body:       { new_public_key: <K2 PEM>,
              rotation_attestation: <base64url Ed25519 sig by K1
                                     over `usrcp-rotate-v1\n<K2 PEM>`> }
```

The outer signature proves the request reached the cloud from someone
controlling K1's private key right now. The inner attestation proves
that the *same* party authored the rotation (it can't have been
swapped in by a transport-layer adversary between client and cloud,
even if such an adversary could see plaintext bodies). The detached
signature uses a v1 domain string so future versions can change
parameters without ambiguity.

On success the cloud, inside a single transaction:

1. `SELECT public_key FOR UPDATE` on the K1 user row.
2. RE-check `revoked_keys` for K1 inside the locked transaction (auth
   already checked it but a concurrent rotation could have committed
   in the meantime). If found, abort with 409 `CONCURRENT_ROTATION`.
3. `INSERT INTO users (public_key, created_at, last_seen_at)` copying
   `created_at` from K1, so the user's join date is preserved. If
   `INSERT-from-SELECT` returns 0 rows, abort with 409
   `CONCURRENT_ROTATION`.
4. For `stream_events` and `stream_embeddings`: the composite FK on
   `stream_embeddings(user_public_key, event_id) REFERENCES
   stream_events(user_public_key, event_id)` declares only ON DELETE
   CASCADE, so a plain UPDATE of the parent would orphan the child
   rows. Instead the rotation:
     a. `INSERT INTO stream_events ... SELECT $K2, ... FROM stream_events WHERE user_public_key = $K1`
     b. `INSERT INTO stream_embeddings ... SELECT $K2, ... FROM stream_embeddings WHERE user_public_key = $K1`
     c. `DELETE FROM stream_embeddings WHERE user_public_key = $K1`
     d. `DELETE FROM stream_events WHERE user_public_key = $K1`
   (child copied AFTER parent so the FK is valid throughout, child
   deleted BEFORE parent for the same reason.)
5. `UPDATE <each child table> SET user_public_key = K2 WHERE user_public_key = K1` for the remaining per-user tables:
   timeline_events, core_identity, global_preferences, domain_context,
   active_projects, schemaless_facts, domain_maps. These FKs only
   reference `users(public_key)` so plain UPDATE is safe once the K2
   users row already exists from step 3.
6. `DELETE FROM pairing_bundles WHERE owner_public_key = K1` (stale).
7. `DELETE FROM seen_nonces WHERE user_public_key = K1` (housekeeping).
8. `DELETE FROM users WHERE public_key = K1`.
9. `INSERT INTO revoked_keys (public_key, rotated_to) VALUES (K1, K2) ON CONFLICT DO NOTHING`.

The auth middleware (`packages/usrcp-cloud/src/auth.ts`) checks
`revoked_keys` BEFORE the nonce-claim / users-upsert path, so a
revoked key cannot create a fresh phantom user record by re-presenting
itself after rotation. A revoked key gets 401 `KEY_REVOKED` on every
authenticated endpoint.

## Threat model

What rotation protects against:

- **Lost device with copy of keys/.** Once K1 is revoked, an attacker
  who has the private.pem ciphertext + master.salt + master.verify can
  still try passphrase guesses offline, but every cloud write or read
  signed by K1 will be rejected. Their offline view of stolen
  ciphertext from before rotation is unchanged (rotation cannot
  rewrite history).
- **Compromised passphrase.** If the user discloses their passphrase
  to an attacker (phishing, shoulder-surf), rotating immediately
  invalidates K1 server-side. The user picks a fresh passphrase via
  `usrcp rotate-key` separately (out of scope here).

What rotation does NOT protect against:

- **Reads or writes the attacker already performed before rotation.**
  Cloud history is preserved across rotation; rotation cannot
  retroactively undo a leak.
- **Attacker who races the user to the cloud.** If both K1 and the
  legitimate user POST a rotation simultaneously, the cloud honours
  whichever signed request lands first. After that, the loser is
  locked out of their own data. Recovery requires recreating the
  identity from scratch.
- **A trojaned local binary.** Out of scope - same supply-chain risk
  as the rest of the codebase.

## Multi-rotation chains

A user can rotate as many times as they like: K1 -> K2 -> K3 -> ...
Each rotation appends a row to `revoked_keys` with the *previous* key
as `public_key` and the *next* key as `rotated_to`. Only the most
recent key has a live `users` row. The `idx_revoked_rotated_to` index
lets the cloud answer "where did this key go" for a confused client
that signed with a stale key.

Rotating BACK to a previously-revoked key is rejected with 409
`NEW_KEY_REVOKED`. The user must pick a fresh keypair.

## Out of scope

- Re-pairing prompts for other devices. The CLI just tells the user
  to re-pair manually after rotation; there's no push channel from
  the cloud to those devices.
- Passphrase rotation. `usrcp rotate-key` (already in the codebase)
  handles that orthogonally.
- Audit log of rotations beyond the `revoked_keys` row.

## Surface area added / changed

**Server:**
- `packages/usrcp-cloud/src/schema.ts`: new `revoked_keys` table.
- `packages/usrcp-cloud/src/auth.ts`: revoked-key check before nonce
  claim and users upsert.
- `packages/usrcp-cloud/src/rotate.ts`: new Fastify plugin with
  `POST /v1/rotate-identity` and `ROTATE_ATTESTATION_DOMAIN` export.
- `packages/usrcp-cloud/src/server.ts`: wires `registerRotateRoutes`.
- `packages/usrcp-cloud/src/__tests__/rotate-routes.test.ts`: 7 tests.

**Client:**
- `packages/usrcp-local/src/rotate-identity.ts`: new `rotateIdentity`
  function that generates K2, signs attestation, POSTs, and writes
  the new keys atomically with rollback.
- `packages/usrcp-local/src/index.ts`: `usrcp rotate-identity` CLI
  subcommand with interactive confirmation + `--yes` for non-TTY.
- `packages/usrcp-local/src/__tests__/rotate-identity.test.ts`: 4 tests.

**Stream:**
- `packages/usrcp-stream/src/__tests__/rotate-integration.test.ts`:
  full A-rotates-K1-to-K2 round-trip with in-process Fastify + pg-mem.

## Verification

```bash
(cd packages/usrcp-cloud  && npm run build && npm test)  # 63 tests (+8)
(cd packages/usrcp-local  && npm run build && npm test)  # 394 tests (+4)
(cd packages/usrcp-stream && npm run build && npm test)  # 107 tests (+1)
```

All three suites green. The integration test asserts that after
rotation: K1 is rejected with 401 KEY_REVOKED, K2 reads K1's
pre-rotation events and identity row, and the cloud's `users` table
holds exactly one row (K2) plus a `revoked_keys` row recording the
K1 -> K2 transition.
