# Task 02 — Schemaless `extensions` table

**Repo:** `/Users/frankbot/usrcp/packages/usrcp-local/`.

## Goal

Add a free-form, encrypted key/value table so domains can store data the fixed schema doesn't model (habits, relationships, recurring tasks, mood, etc.) without requiring a migration each time a new domain wants something new.

## What to do

### 1. New SQLite table in `src/ledger.ts`

```sql
CREATE TABLE schemaless_facts (
  fact_id TEXT PRIMARY KEY,           -- ULID
  domain TEXT NOT NULL,                -- HMAC pseudonym (same scheme as timeline_events)
  namespace TEXT NOT NULL,             -- encrypted: e.g., "habits", "relationships"
  key TEXT NOT NULL,                   -- encrypted: e.g., "morning_routine"
  value TEXT NOT NULL,                 -- encrypted: free-form JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_facts_domain ON schemaless_facts(domain);
```

All encrypted columns use the existing domain-scoped key derivation in `encryption.ts` — do not invent a new key path.

### 2. Ledger methods

Add to `src/ledger.ts`:

- `setFact(domain, namespace, key, value)` — upserts (one row per `(domain, namespace, key)`)
- `getFact(domain, namespace, key)` — single fact
- `listFacts(domain, namespace?)` — all facts in domain (optionally filtered by namespace)
- `deleteFact(fact_id)` — secure delete

### 3. MCP tools in `src/server.ts`

Expose two new tools:

- `usrcp_set_fact` — write a fact
- `usrcp_get_facts` — read facts (single or list)

Reuse the same Zod validation patterns as existing tools (max lengths, bounded records).

### 4. Wire into key rotation

`Ledger.rotateKey()` must re-encrypt this table in the same atomic transaction as the others. See `src/ledger.ts` for the existing rotation pattern.

### 5. Tests

Add to `src/__tests__/ledger.test.ts` and `src/__tests__/encryption.test.ts`:

- Write/read roundtrip
- Domain isolation (facts in domain A unreadable with domain B's key)
- Key rotation roundtrip preserves all facts
- List pagination if you implement it

## Out of scope

- Don't add semantic search over facts (that's task 3)
- Don't expose this in the protocol spec yet — keep it as a local-only extension until the API stabilizes

## Acceptance criteria

- New tests pass
- Full suite still green (currently 145/150)
- `usrcp_set_fact` and `usrcp_get_facts` callable from Claude Code

## Files to read first

- `packages/usrcp-local/src/ledger.ts` — existing CRUD patterns
- `packages/usrcp-local/src/encryption.ts` — domain-scoped key derivation
- `packages/usrcp-local/src/server.ts` — existing MCP tool patterns
- `packages/usrcp-local/src/__tests__/ledger.test.ts` — test style
