# usrcp-cloud

Hosted ledger for USRCP — ciphertext-only cross-device sync. Accepts
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

- `POST /v1/events` — append a batch of encrypted events (≤ 500)
- `GET  /v1/events` — paginated reader for a device cursor
- `POST /v1/identity`, `/v1/preferences`, `/v1/domain-maps` — encrypted
  snapshots with optimistic-concurrency `expected_version`
- `POST /v1/stream/push` — append a batch of encrypted `usrcp-stream`
  events (≤ 500), optionally each with an encrypted embedding payload.
  Idempotent on `event_id`; assigns per-user monotonic `server_seq`.
- `GET  /v1/stream/pull?since=N&limit=N` — paginated reader for stream
  events with `server_seq > N`. Embeddings are returned attached to
  each event when present.
- `GET  /healthz` — cheap liveness check (no DB roundtrip)

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

Threads, surface_state, and stream-config are NOT synced — threads are
derived state (the client stitcher re-runs on pull), and active-surface
is per-device by design.

Schema details: see `stream_events` and `stream_embeddings` in
`src/schema.ts`. The plugin lives in `src/stream.ts` and registers via
`registerStreamRoutes(app, db)` from `src/server.ts`.

## What the server *can* see

- Account pseudonym, device pseudonym, monotonic ledger sequence
- Idempotency key, client timestamp, version numbers
- Sizes of ciphertext fields

That's all. No plaintext content, no domain names, no contact handles.
