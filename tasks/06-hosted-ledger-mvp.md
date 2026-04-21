# Task 06 — Hosted ledger MVP for multi-device sync

**Repo:** `/Users/frankbot/usrcp/` — new package: `packages/usrcp-cloud/`.

## Context

This is the biggest task — it's the actual business and what the pitch deck describes. **Treat as a multi-week effort, not a single Claude session.** This brief covers Phase 1 only.

Without cross-device sync, USRCP is a polished local memory vault. With it, USRCP becomes the protocol the pitch promises.

## Goal (Phase 1)

Stand up a minimum-viable hosted ledger that lets a single user push events from device A and read them from device B, with the same encryption guarantees as local.

## What to do

### 1. New package: `packages/usrcp-cloud/`

- Server framework: **Fastify** or **Hono** (pick one, don't bikeshed)
- Storage: **Postgres** (Neon for hosted dev, local Postgres for tests)
- Mirror the local SQLite schema as closely as possible — but everything stored as ciphertext only

### 2. Endpoints (per `spec/PROTOCOL.md` §6)

- `GET /v1/state?since=<sequence>` — return events since cursor
- `POST /v1/events` — append new events
- `POST /v1/state` — update identity/preferences/etc.
- All endpoints require Ed25519-signed requests (see auth below)

### 3. CRITICAL: ciphertext-only server

- The user's device holds the master key
- The server **never sees plaintext** — ever
- Server stores opaque encrypted blobs
- This is the differentiator vs Mem0 — write it into the README + pitch
- If you ever find yourself decrypting on the server, you've broken the model

### 4. Sync model

- Client maintains a local `ledger_sequence` cursor
- On `get_state`, request events `since=<cursor>`
- Server returns ciphertext
- Client decrypts locally with the user's key
- Conflict resolution: per task 04 — last-write-wins on metadata records, append-only for timeline

### 5. Identity (Phase 1: no accounts)

- User-supplied 32-byte device key (Ed25519 keypair)
- No accounts, no email, no OAuth in Phase 1
- Public key = user identifier (server stores public key, never sees private)
- Sign every request with the private key
- Server verifies signature on every request

### 6. Deployment

- Target: **Fly.io** or **Railway** (don't over-engineer)
- Single region, single Postgres instance — fine for MVP
- Add a basic Dockerfile + deploy script

### 7. Client integration

Add to `packages/usrcp-local/`:

- `usrcp sync push` — push local events to hosted ledger
- `usrcp sync pull` — pull events from hosted ledger and merge into local
- `usrcp sync status` — show last sync time, pending events, etc.
- Configure with `usrcp config set cloud_endpoint=<url>`

## Out of scope (Phase 1)

- Multi-user isolation (use a per-user Postgres schema or row-level filter for now)
- Team contexts
- Billing
- Web dashboard
- Real-time push / WebSocket sync
- Edge caching (the spec's sub-50ms architecture is a Phase 3 problem)

## Acceptance criteria

- A user can `init` on laptop, write events, then `init` on phone with the **same passphrase**, run `usrcp sync pull`, and see those events
- Server-side database inspection shows **only ciphertext** in every column except structural metadata (event_id, timestamp, sequence, public_key)
- Signed-request validation works; unsigned/wrongly-signed requests are rejected
- Basic deploy works (one command from `packages/usrcp-cloud/`)

## Phase 2 (separate task — do not do in this round)

- Auth + accounts + billing
- Multi-user isolation
- Web dashboard
- Edge caching

## Files to read first

- `spec/PROTOCOL.md` — endpoint definitions, auth handshake, latency targets
- `packages/usrcp-local/src/encryption.ts` — encryption primitives to mirror client-side
- `packages/usrcp-local/src/ledger.ts` — schema to mirror in Postgres
- `strategy/PITCH.md` — the business case this unlocks
