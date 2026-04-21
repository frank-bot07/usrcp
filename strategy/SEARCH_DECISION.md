# Search Story Decision — Semantic Embeddings vs Structured Memory

**Status:** Recommendation. Awaiting Chad's approval before implementation.
**Date:** 2026-04-21
**Owner:** TBD — whoever implements the chosen path

---

## TL;DR

**Recommendation: Path B — reframe USRCP as structured memory, not
general-purpose conversational recall.**

Lean into the cryptographic architecture as the wedge. Ship the docs
update, add a "not this, this" comparison table against Mem0/Zep in the
README, and stop implying fuzzy recall works today. Path A (encrypted
embeddings) is reachable later as `usrcp-search-embeddings`, an opt-in
extension — but it would compromise the single strongest story USRCP has
today, and the addressable market for structured cross-platform memory is
already large enough to fund the company.

---

## Context

The current search stack is an HMAC blind index over n-gram tokens
(`packages/usrcp-local/src/encryption.ts:353`). It does **prefix and
keyword** matching inside a cryptographically opaque index — the server
never sees plaintext, even encrypted. That's genuinely unusual and
defensible.

It **cannot** do semantic similarity. A user asking "what did I tell you
about my anxiety meds" expects a match against events summarized as
"discussed sertraline dosage"; the blind index returns nothing because
there's no token overlap.

USRCP's README and pitch imply general-purpose AI memory ("the missing
standard for human-to-AI memory"). The implementation is structured and
keyword-only. Closing that gap is this decision.

---

## Path A — Encrypted semantic embeddings

### What it looks like

- Column `summary_embedding BLOB` on `timeline_events` and
  `schemaless_facts`. Dimensions: 384 (MiniLM-L6) or 768 (mpnet).
- On write, derive an embedding locally. Two sub-options:
  - **A1:** `@xenova/transformers` (Node-native, ~80 MB model, MiniLM-L6
    quality, runs on CPU).
  - **A2:** Python sidecar with `sentence-transformers` (better models,
    GPU-friendly, adds a second process).
- Encrypt the embedding bytes with the domain-scoped key before storing.
- On search:
  1. Fetch all encrypted embeddings in the candidate domain set.
  2. Decrypt in-process (never leaves the client).
  3. Compute cosine similarity against the query embedding.
  4. Return top-K events above a threshold.

### What it costs

- **Process memory:** +50-100 MB per loaded model (MiniLM is smaller but
  not negligible).
- **First-start latency:** embedding model download (~80 MB) or sidecar
  spawn.
- **Dependency surface:** `@xenova/transformers` (ONNX runtime, tokenizer,
  model files) or a Python sidecar that users must install.
- **Search latency:** O(domain\_size) decryption per query — fast for
  10K events, slow for 1M. Index-free by design; there is no way to
  narrow down candidates without plaintext.
- **Threat model:** this is the important one. See below.

### Threat-model cost (the one that matters)

Today, the blind index is one of two properties that differentiate USRCP
from Mem0/Zep. It's unusual enough that it's worth saying aloud in the
pitch: *search indexes reveal plaintext even when the payload is
encrypted.* Most vector memory products have this weakness today. Fixing
it is structurally hard.

Adding encrypted embeddings compromises this. Specifically:

- An embedding is a deterministic function of the plaintext. Two records
  with similar plaintext produce similar embedding vectors.
- If an attacker can decrypt *any* embedding (e.g., via key compromise or
  side-channel), they get a semantic similarity oracle over the entire
  index — without needing to decrypt every record.
- The encrypted blobs themselves leak structure: an attacker with known
  plaintext ("I have anxiety") can embed it themselves and compute
  cosine similarity against encrypted ciphertexts (with key) to identify
  related records.

This is solvable with HE schemes (CKKS cosine similarity) or FHE, but
those are not shipping in a Node package today. Practically, the
honest-attacker threat model becomes:

> If the master key is intact, your memory is confidential.
> If the master key is compromised, semantic structure is recoverable
> faster than it would be with exact-keyword encryption.

That's a real downgrade from the current posture. It must be documented
in `docs/SECURITY.md` if we ship this.

### When to pick Path A

- If positioning USRCP as a *capability*-competitive alternative to Mem0
  and Zep — selling to consumers who want fuzzy recall and don't read
  security docs.
- If the business case rests on being the best at AI memory, not the
  most secure.
- If we're willing to accept that "zero-knowledge" becomes aspirational
  rather than current.

---

## Path B — Reframe as structured memory

### What it looks like

- Update `README.md`, `spec/PROTOCOL.md`, `strategy/PITCH.md`,
  `strategy/GTM.md` to explicitly position USRCP as **structured user
  state**: identity, preferences, projects, timeline events, schemaless
  facts. Not free-form conversational memory.
- Add a comparison table in `README.md`:

  | | USRCP | Mem0/Zep |
  |---|---|---|
  | Storage | Structured schema + encrypted facts | Opaque vector blobs |
  | Search | Exact keyword (blind index) | Semantic (vector) |
  | Query model | "What is the user's timezone?" | "What did the user feel last week?" |
  | Server sees plaintext? | No, ever | Yes, at embed time |
  | Cross-device sync security | Zero-knowledge (pending hosted ledger) | Provider-trusted |
  | Use case | Cross-platform persistent state | Conversational recall |
  | Audit log | Cryptographically signed | Provider log |

- Lean the pitch into three narrow wedges:
  1. **Compliance.** Regulated industries (health, finance, legal)
     can't ship agents that phone a third-party memory service with
     plaintext. USRCP is the only option that isn't "don't use AI
     memory."
  2. **Cross-platform structure.** The interesting state is identity
     and preferences, not fuzzy anecdotes. Users type their stack into
     Claude Code *and* Cursor today — that's a structured problem.
  3. **Key sovereignty.** Users own the encryption key. No vendor
     lock-in; no forced migrations; no breach can exfiltrate plaintext.

### What it costs

- Zero code — it's a docs sweep and a positioning decision.
- Gives up the "answer any question about your past" pitch. Users
  coming from ChatGPT memory will bounce off "but I want fuzzy recall."
- Narrows TAM from "every AI user" to "developers + compliance-sensitive
  enterprises." That's still a >$100M TAM market, but not a trillion-
  dollar one.

### When to pick Path B

- If the defensible moat is cryptographic architecture, not search
  quality.
- If the buyer is a security-conscious developer or an enterprise legal
  team — not a consumer.
- If we believe Mem0/Zep will out-execute us on semantic capability but
  cannot match us on zero-knowledge without rearchitecting (they can't,
  easily).

---

## Recommendation

**Path B.**

Three reasons:

1. **We can't win Path A's game.** Mem0 raised $25M in 2025 to do exactly
   this. Zep has been shipping semantic memory for two years. If USRCP
   enters that race as a Node package with a CPU-only MiniLM model, it's
   a perpetual second-place product at best.

2. **Path A burns the one unique asset.** Zero-knowledge search is the
   single thing we can say that nobody else can. Losing that to chase
   capability parity is trading a moat for a feature.

3. **The actual buyer doesn't want fuzzy recall.** A developer
   configuring their coding style across five AI tools wants
   deterministic, structured state. An enterprise shipping an agent into
   a regulated domain wants auditable, compliant memory. Neither cares
   whether the agent can semantically recall a mood.

Path A becomes reachable later as **opt-in `usrcp-search-embeddings`**,
documented honestly as a capability/security tradeoff the user consents
to per-domain. That preserves the zero-knowledge default while letting
individual users buy into semantic search for low-sensitivity domains
(e.g., public-facing preferences, never for health or finance).

---

## If you approve Path B, the work is

1. **README.md** — rewrite the pitch para, add the comparison table,
   remove "general-purpose AI memory" framing.
2. **strategy/PITCH.md** — strike the consumer-TAM paragraph, sharpen
   the compliance/developer wedge.
3. **strategy/GTM.md** — adjust go-to-market to lead with compliance
   and developer channels, not consumer.
4. **spec/PROTOCOL.md** — the protocol already describes structured
   operations; add a "non-goals" section that explicitly excludes
   semantic memory from v0.x.
5. **docs/SECURITY.md** — add a "Search architecture" subsection
   explaining blind index + its tradeoff vs semantic.

Estimated effort: 1 focused afternoon of writing, no code.

---

## If you approve Path A instead

1. Land the `@xenova/transformers` dependency, gated behind a feature
   flag so non-users don't pay the memory cost.
2. Add `summary_embedding` column to `timeline_events` and
   `schemaless_facts`; wire into key rotation.
3. Write the honest threat-model update in `docs/SECURITY.md`.
4. Add tests for: embedding roundtrip, cosine similarity correctness,
   domain isolation (embeddings from domain A not decryptable with
   domain B key), key rotation preserves embeddings.
5. Ship as `usrcp_semantic_search` MCP tool alongside the existing
   `usrcp_search_timeline`.

Estimated effort: 1-2 weeks, one focused engineer.

---

## What I'm asking for

One of:

- "Go Path B" — I'll do the docs pass.
- "Go Path A" — I'll land the embeddings work.
- "Neither, do X instead" — some third option I haven't considered.

Please don't answer "both."
