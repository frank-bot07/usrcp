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
- `GET  /healthz` — cheap liveness check (no DB roundtrip)

All event payloads cap at 128 KiB for `detail_enc`; smaller caps apply
per-field. See `src/server.ts` for the exact Zod schema.

## What the server *can* see

- Account pseudonym, device pseudonym, monotonic ledger sequence
- Idempotency key, client timestamp, version numbers
- Sizes of ciphertext fields

That's all. No plaintext content, no domain names, no contact handles.
