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
The server stores ciphertext bundles and never calls the decrypt path,
but the bundle's decryption key is derived from the 8-digit `code` that
the server also stores - so the cloud is **trusted for the 10-minute
TTL window**, not cryptographically blocked from decrypting. See the
Threat model section below.

- `POST /v1/pairing/init` (Ed25519-signed): device A uploads a bundle
  encrypted client-side under `scrypt(code, FIXED_PAIRING_SALT)`. Body:
  `{ code: "12345678", encrypted_bundle, ttl_seconds? }`. Defaults to a
  10-minute TTL (max 30 minutes). Returns the expiration timestamp.
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

### Threat model

The server sees: the 8-digit code (stored verbatim as the row's primary
key), the Ed25519 signature from device A, and the opaque ciphertext
blob. Because the bundle is encrypted under
`scrypt(code, FIXED_PAIRING_SALT, N=131072)` and the cloud holds the
code alongside the ciphertext, **the cloud has the decryption material
during the 10-minute TTL.** It cannot decrypt by design (it never calls
the scrypt KDF), but anyone with read access to the row (DB dump, log
that captured the POST body, malicious operator) can derive the key
offline in a single scrypt invocation - this is not a brute-force
problem; the code IS the key.

The 5-attempts-per-code cap protects against an *external* attacker who
does NOT know the code (e.g., someone probing the public GET endpoint).
It does nothing against the cloud itself. The 10-min default TTL bounds
how long a compromised row stays exposed.

**Operational guidance:** if you do not trust your cloud provider for a
10-minute window per pairing, do not use this flow - copy `keys/`
between devices manually over SSH/USB instead. See
`tasks/11-multi-device-pairing.md` for the full design rationale and
the tier-2 redesign options (out-of-band secret, hashed lookup key)
that would close this gap at the cost of UX.

## What the server *can* see

- Account pseudonym, device pseudonym, monotonic ledger sequence
- Idempotency key, client timestamp, version numbers
- Sizes of ciphertext fields

That's all. No plaintext content, no domain names, no contact handles.
