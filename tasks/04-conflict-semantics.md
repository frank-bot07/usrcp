# Task 04 — Define conflict resolution semantics for concurrent writers

**Repo:** `/Users/frankbot/usrcp/`.

## Goal

Spec out and implement what happens when two agents write competing events or preferences simultaneously. Currently undefined — will bite the moment a second writer exists.

## What to do

### 1. Add a "Concurrency Model" section to `spec/PROTOCOL.md`

Cover each table's semantics explicitly:

- **Timeline events:** append-only, no conflict possible — each event gets its own ULID + monotonic `ledger_sequence`. Document this explicitly.
- **Identity / preferences / domain_context:** last-write-wins per field, with `updated_at` as the tiebreaker. Document that two agents writing different values for `verbosity` simultaneously will see one overwrite the other; an agent that needs read-modify-write semantics must use the `expected_version` parameter (below).
- **Active projects:** last-write-wins on the row, with `last_touched` as tiebreaker.
- **Schemaless facts** (from task 02): same as preferences — last-write-wins per `(domain, namespace, key)`.

### 2. Implement optimistic concurrency

Add an `expected_version` parameter on the update tools:
- `usrcp_update_identity`
- `usrcp_update_preferences`
- `usrcp_update_domain_context`
- `usrcp_set_fact` (from task 02)

Behavior: if `expected_version` is passed and the current version doesn't match, return a `VERSION_CONFLICT` error so the caller can re-read and retry. **Make it optional** so existing callers don't break.

### 3. Add `version` columns

Add `version INTEGER NOT NULL DEFAULT 1` to:
- `core_identity`
- `global_preferences`
- `domain_context`
- `schemaless_facts` (from task 02)

Increment on every write inside the same transaction as the update.

### 4. Tests

Add to `src/__tests__/ledger.test.ts`:
- Concurrent timeline writes don't lose events
- Concurrent preference writes converge to one of the two values (no data corruption, no partial writes)
- `expected_version` mismatch returns a clean `VERSION_CONFLICT` error
- `expected_version` match succeeds and increments the version

## Out of scope

- **No CRDTs.** Last-write-wins is fine for v0.x.
- **No vector clocks.** Revisit if/when multi-device hosted ledger lands (task 06).
- **No automatic merge.** Callers handle conflicts at the application layer.

## Acceptance criteria

- Spec section written and merged into `spec/PROTOCOL.md`
- Version columns + optimistic concurrency implemented in `ledger.ts` + `server.ts`
- Tests green

## Files to read first

- `spec/PROTOCOL.md` — existing structure
- `packages/usrcp-local/src/ledger.ts` — existing update patterns
- `packages/usrcp-local/src/server.ts` — existing tool definitions
- `packages/usrcp-local/src/__tests__/ledger.test.ts` — test style
