# usrcp-cloud

Hosted ledger for USRCP - ciphertext-only cross-device sync. Accepts
encrypted timeline events, identity blobs, preferences, and domain maps
from `usrcp-local` clients running on different machines, and serves
them back to other clients of the same user. The server **cannot
decrypt** any value column; it stores opaque ciphertext and serves it
verbatim.

Auth is HMAC-signed nonces (per-event, per-snapshot), so a stolen API
token cannot replay an old payload past the nonce TTL.

## Install and run

```bash
cd packages/usrcp-cloud
npm install
npm run build
DATABASE_URL=postgres://... node dist/index.js
```

| Env var        | Default     | Purpose                          |
| -------------- | ----------- | -------------------------------- |
| `DATABASE_URL` | (required)  | Postgres connection string       |
| `PORT`         | `3000`      | HTTP listen port                 |
| `HOST`         | `0.0.0.0`   | Bind address                     |

Migrations run automatically at startup. A 5-minute `setInterval`
prunes expired nonces.

## Endpoints

- `POST /v1/events` - append a batch of encrypted events (≤ 500)
- `GET  /v1/events` - paginated reader for a device cursor
- `POST /v1/identity`, `/v1/preferences`, `/v1/domain-maps` - encrypted
  snapshots with optimistic-concurrency `expected_version`
- `POST /v1/stream/push` - append a batch of encrypted `usrcp-stream`
  events (≤ 500), optionally each with an encrypted embedding payload.
  Idempotent on `event_id`; assigns per-user monotonic `server_seq`.
- `GET  /v1/stream/pull?since=N&limit=N` - paginated reader for stream
  events with `server_seq > N`. Embeddings are returned attached to
  each event when present.
- `GET  /healthz` - cheap liveness check (no DB roundtrip)

All event payloads cap at 128 KiB for `detail_enc`; smaller caps apply
per-field. See `src/server.ts` for the exact Zod schema.

## Stream sync routes

`POST /v1/stream/push` and `GET /v1/stream/pull` mirror the ledger sync
shape but back `usrcp-stream`'s separate event/embedding tables. The
server stores ciphertext only here too:

- `stream_events.channel_ref_enc / author_ref_enc / content_enc /
  entity_refs_enc` come pre-encrypted under the client's `stream-events`
  HKDF domain.
- `stream_embeddings.vec_enc / model_enc` come pre-encrypted under the
  client's `stream-embeddings` HKDF domain (a different per-passphrase
  derived key than ledger or stream-events).
- `surface / side / content_kind / ts_ms` stay plaintext (same posture
  as the ledger's `domain_pseudonym` + timestamps).

Threads, surface_state, and stream-config are NOT synced - threads are
derived state (the client stitcher re-runs on pull), and active-surface
is per-device by design.

Schema details: see `stream_events` and `stream_embeddings` in
`src/schema.ts`. The plugin lives in `src/stream.ts` and registers via
`registerStreamRoutes(app, db)` from `src/server.ts`.

## Pairing routes

Multi-device pairing lets a new device join an existing user's Ed25519
identity via the cloud, without manually copying the `keys/` directory.

**v2 design (current):** the user-facing pairing string is `<8 digit
code>-<16 random bytes in hex>`, e.g.
`1234-5678-aabbccdd-eeff0011-22334455-66778899`. Device A POSTs the
8-digit `code` plus a ciphertext encrypted under
`HKDF-SHA256(IKM=secret, salt=code, info="usrcp-pairing-v2")`. The
16-byte secret travels device-to-device via the printed string (paste,
QR, AirDrop, etc.) and **never reaches the cloud**, which is why the
server cannot decrypt the bundle even if its DB or logs leak.

- `POST /v1/pairing/init` (Ed25519-signed): device A uploads a bundle
  encrypted client-side under
  `HKDF-SHA256(IKM=secret, salt=code, info="usrcp-pairing-v2")` where
  `secret` is 16 random bytes held only by the two devices. Body:
  `{ code: "12345678", encrypted_bundle, ttl_seconds? }`. The body
  carries the lookup code only; the secret never reaches the server.
  Defaults to a 10-minute TTL (max 30 minutes). Returns the
  expiration timestamp.
- `GET /v1/pairing/claim/:code` (unauthenticated; device B has no
  identity yet): atomically increments `claim_attempts` and returns
  `{ encrypted_bundle, owner_public_key, expires_at, attempts_remaining }`.
  Returns 404 once expired or unknown, 429 after 5 wrong attempts.
- `GET /v1/pairing/list` (Ed25519-signed): owner inspects their pending
  bundles.
- `DELETE /v1/pairing/:code` (Ed25519-signed; owner-only): cancel a
  pending bundle.

The same `setInterval` that prunes nonces also deletes pairing rows that
have expired or hit the 5-attempt cap.

### Threat model (v2)

The server sees: the 8-digit code (stored verbatim as the row's primary
key), the Ed25519 signature from device A, and the opaque ciphertext
blob. It does NOT see the 16-byte secret; the secret half of the
pairing string is transferred device-to-device out of band. The bundle
is encrypted under `HKDF-SHA256(IKM=secret, salt=code,
info="usrcp-pairing-v2")` so a 128-bit-entropy secret stretches to a
256-bit AES-GCM key. An attacker with row-level access to the
`pairing_bundles` table sees the lookup code and the ciphertext only;
without the secret, brute-force is 2^128 work.

The 5-attempts-per-code cap protects against an external attacker
probing the public claim endpoint who doesn't have the code. The
10-min default TTL bounds how long a row stays around after pairing.

The previous v1 design (code = scrypt input) made the cloud trusted
for the TTL window; it has been retired. The decision write-up lives in
`tasks/12-pair-tier-2.md`; the historical v1 context is preserved in
`tasks/11-multi-device-pairing.md`.

## Identity rotation

`POST /v1/rotate-identity` lets a user replace their Ed25519 identity
without losing cloud-side data. Authentication is the standard signed
header set using the OLD key (K1). Body:

```json
{
  "new_public_key": "<PEM>",
  "rotation_attestation": "<base64url Ed25519 signature by K1 over `usrcp-rotate-v1\\n<new_pem>`>"
}
```

On success the server atomically:

1. Re-points every child row (timeline_events, core_identity,
   global_preferences, domain_context, active_projects,
   schemaless_facts, domain_maps, stream_events, stream_embeddings)
   from K1 to K2.
2. Drops any pending pairing_bundles owned by K1 (they're stale).
3. Replaces the K1 row in `users` with K2, preserving `created_at`.
4. Inserts a row into `revoked_keys` recording `(K1 -> K2)`.

After rotation, every signed request from K1 is rejected with 401
`KEY_REVOKED` (the auth middleware checks `revoked_keys` before the
nonce-claim / upsert path, so a revoked key cannot recreate a phantom
user). The cloud rejects rotations that would target a key already in
use (`409 NEW_KEY_IN_USE`) or a previously-revoked key
(`409 NEW_KEY_REVOKED`).

See `tasks/13-identity-rotation.md` for the threat model and the
client side of the protocol.

- Account pseudonym, device pseudonym, monotonic ledger sequence
- Idempotency key, client timestamp, version numbers
- Sizes of ciphertext fields

That's all. No plaintext content, no domain names, no contact handles.
