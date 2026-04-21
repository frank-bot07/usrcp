# Task 03 — Decide search story: semantic embeddings vs structured-memory framing

**Repo:** `/Users/frankbot/usrcp/`.

## Context

Current search uses HMAC blind index with n-gram tokens (see `packages/usrcp-local/src/encryption.ts`). It does prefix/keyword matching but **cannot do semantic similarity**. Users coming from ChatGPT memory expect "remind me what I told you about my anxiety meds" to work. It won't, today.

The README and pitch materials currently imply general-purpose AI memory; the implementation is structured/keyword-only memory. This is a brand-vs-implementation gap that needs a deliberate decision.

## This is a decision task, not a coding task

Pick **one** path and execute it. Don't try to do both.

---

## Path A — Add encrypted embeddings

**What it looks like:**

- Add a column `summary_embedding BLOB` to `timeline_events` (and optionally `schemaless_facts` from task 02).
- On write, generate an embedding locally:
  - Option A1: `@xenova/transformers` (Node-native, ~80MB model, MiniLM-L6 quality)
  - Option A2: Python sidecar with `sentence-transformers`
- Encrypt the embedding bytes with the domain key before storing.
- On search:
  1. Decrypt all embeddings in the candidate domain set
  2. Cosine-similarity against the query embedding
  3. Return top-K events
- **Honest threat-model update required:** semantic search costs you the property that the search index is opaque at rest. Document this in `docs/SECURITY.md`.

**Cost:** ~50–100MB extra process memory for the embedding model, one extra dependency, real semantic recall.

**When to pick this:** If USRCP is positioned as general-purpose AI memory and competing with Mem0/Zep on capability.

---

## Path B — Reframe as structured memory

**What it looks like:**

- Update `README.md`, `spec/PROTOCOL.md`, and `strategy/PITCH.md` to explicitly say USRCP stores **structured user state** (identity, preferences, projects, timeline events) — not free-form conversational memory.
- Position competitors honestly: "USRCP is to ChatGPT memory what Postgres is to a notebook. Different tool, different use case."
- Add a comparison table in README contrasting:
  - **USRCP:** structured, encrypted, queryable, schema-driven
  - **Mem0/Zep:** semantic, vector, conversational, embedding-driven
- Lean into compliance + domain isolation as the wedge — those are things Mem0/Zep can't easily match.

**Cost:** Zero engineering, but you give up the "AI memory" general-purpose pitch and narrow the addressable market.

**When to pick this:** If the differentiator is the cryptographic architecture and the buyer is a security-conscious dev or enterprise — not a consumer wanting fuzzy recall.

---

## What to do

1. **Write a 1-page tradeoff doc** at `strategy/SEARCH_DECISION.md` summarizing both paths.
2. **Recommend one** based on what's defensible long-term given the existing architecture and positioning.
3. **Wait for Chad's approval** before implementing.
4. After approval, execute the chosen path:
   - Path A: code + tests + SECURITY.md update
   - Path B: docs updated everywhere the framing appears (README, PROTOCOL.md, PITCH.md, GTM.md)

## Acceptance criteria

- A decision doc exists at `strategy/SEARCH_DECISION.md`
- Chad has signed off on a path
- The chosen path is implemented end-to-end (no half-finished docs or partial code)

## Files to read first

- `packages/usrcp-local/src/encryption.ts` — existing blind index
- `README.md`, `strategy/PITCH.md`, `strategy/GTM.md` — current framing
- `docs/SECURITY.md` — current threat model
