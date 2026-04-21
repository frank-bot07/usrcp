# `usrcp-sdk` — legacy prototype

> **Status:** Historical. This package is a January-February 2026 prototype
> that predates the current protocol definition. It **does not implement the
> USRCP protocol as specified in [`/spec/PROTOCOL.md`](../spec/PROTOCOL.md)**
> and should not be used as a reference for new work.

## What this is

`usrcp-sdk v0.3.0` (published once to npm, since superseded) is an
EventEmitter-based TypeScript library with `sql.js` storage and a set of
adapters (OpenClaw / Hermes / Claude / Codex) that pull events from
external APIs into a local `events` stream. It was built to explore the
cross-platform sync idea before the protocol, the schema, and the
security model were decided.

## Why it's not the reference implementation

The current USRCP protocol (spec v0.1.0) requires:

- **Encryption at rest** for every column that can contain user data (AES-256-GCM under a per-user scrypt-derived master key).
- **Domain-scoped keys** enforcing cryptographic isolation between domains.
- **HMAC blind-index search** instead of plaintext-over-sql.js.
- **Schema-driven structured state** (identity, preferences, projects,
  timeline, schemaless facts) rather than an undifferentiated `events`
  stream.
- **Zero-knowledge hosted sync** (the server stores ciphertext only).

None of this is implemented in this prototype. Its storage is plaintext
`sql.js`; there is no key architecture, no blind index, no audit log, no
per-domain isolation. Shipping USRCP as "encrypted, zero-knowledge
structured state" while this package exists under the same brand is a
message-discipline problem, not a missing-feature one.

## Where the real code lives

- **[`/packages/usrcp-local/`](../packages/usrcp-local)** — the MCP server
  reference implementation. 211 tests. Implements the full encryption,
  audit, key-rotation, multi-user, and HTTPS-transport surface.
- **[`/packages/usrcp-cloud/`](../packages/usrcp-cloud)** — the Phase 1
  hosted sync ledger. 25 tests. Ciphertext-only Fastify server with
  Ed25519 signed-request auth.

## Positioning

USRCP today is positioned as **structured, encrypted user state for AI
agents** (see [`/README.md`](../README.md)). It is not positioned as a
cross-channel message sync tool. The Discord↔Telegram↔bot narrative in
the earlier marketing for this package is a different product category
(semantic / conversational memory) that the project explicitly deferred
to Mem0 and Zep — see [`/strategy/SEARCH_DECISION.md`](../strategy/SEARCH_DECISION.md)
for the rationale (Path B).

## What to do with this directory

Open question for the project owner. Options:

1. **Archive in place** (current state — this README).
2. **Move to `archive/usrcp-sdk-prototype/`** to make the "not current" framing structural.
3. **Deprecate the npm package** (`npm deprecate usrcp-sdk "See the /packages/ directory in the repo for the current implementation."`) so nobody accidentally installs it.
4. **Delete the directory** once it's clear nothing on the roadmap depends on this code.

Pick one before publishing anything new to npm under the `usrcp` namespace.
