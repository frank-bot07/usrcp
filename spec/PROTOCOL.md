# USRCP Technical Specification v0.1.0

**User Context Protocol — Wire Format, Authentication, and Latency Architecture**

> **Implementation status**: The `usrcp-local` MCP server implements the core
> operations (`get_state`, `append_event`) with full encryption at rest,
> blind index search, encrypted audit logging, scrypt key derivation, and
> atomic key rotation. See `docs/SECURITY.md` for the implemented encryption
> architecture. Sections marked *[PLANNED]* describe hosted ledger features
> not yet implemented.

---

## 0. Scope and Non-Goals

USRCP is a protocol for **structured user state**: identity, preferences,
active projects, per-domain context, free-form `(domain, namespace, key)`
facts, and an append-only timeline of interaction events. The data model
is schema-driven with a schemaless extension table; the search model is
exact-keyword via HMAC blind index tokens.

### Non-goals in v0.x

- **Semantic search / embeddings / vector recall.** USRCP does not store
  embeddings and does not support cosine-similarity queries. A request
  like "find events similar in meaning to X" is out of scope. Callers
  who need semantic recall should compose USRCP with a semantic memory
  layer (Mem0, Zep, or a self-hosted vector DB); nothing in the protocol
  prevents this, but nothing in USRCP supplies it either. See
  [strategy/SEARCH_DECISION.md](../strategy/SEARCH_DECISION.md).
- **Free-form conversational memory.** USRCP is not a chat-log store. If
  an agent wants fuzzy recall over prior messages, that lives outside
  USRCP.
- **Server-side plaintext.** The hosted ledger (see §6) is ciphertext-only
  by design. The server cannot decrypt user state; any future feature
  that would require plaintext on the server is explicitly out of scope
  for the protocol line.
- **CRDTs and automatic merge.** Conflict resolution is last-write-wins
  with optional `expected_version` optimistic concurrency (see §7). Rich
  merge semantics are deferred.

### What USRCP does provide

- A wire format for reading, writing, and syncing structured state.
- Per-domain encryption keys enforcing cryptographic isolation between
  domains (e.g., "coding" keys cannot decrypt "health" data).
- An encrypted audit log with HMAC integrity tags.
- A hosted sync architecture in which the server persists opaque
  ciphertext and verifies Ed25519-signed requests, but never holds or
  derives a decryption key.
- Optimistic concurrency on metadata records.

---

## 1. Protocol Overview

USRCP defines three operations against a **User State Ledger**:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `get_state` | Agent → Ledger | Read user identity, preferences, and timeline |
| `append_event` | Agent → Ledger | Write a new interaction event |
| `sync` | Agent ↔ Ledger | Bi-directional reconciliation |

Transport: HTTPS/2 with optional WebSocket upgrade for `sync`. All payloads are JSON. Binary attachments use multipart with JSON envelope.

---

## 2. Addressing

### User Identifiers

```
usrcp://<ledger_host>/<user_hash>
```

- `ledger_host`: The User State Ledger instance (e.g., `ledger.usrcp.dev`)
- `user_hash`: SHA-256 truncated to 16 hex chars of the user's canonical email or public key

Users own their identifier. A user can run a self-hosted ledger or use a managed service. The identifier is portable — changing ledger hosts requires a signed migration record.

### Agent Identifiers

```
agent://<platform>/<agent_name>/<instance_id>
```

Agents register once per user. Registration yields a **scoped context key** (Section 4).

---

## 3. Core Operations

### 3.1 `get_state`

**Request:**

```json
{
  "usrcp_version": "0.1.0",
  "method": "get_state",
  "user_id": "usrcp://ledger.usrcp.dev/u_7f3a9b2c",
  "scope": ["core_identity", "global_preferences", "recent_timeline"],
  "requesting_agent": {
    "agent_id": "agent://cursor/code-assistant/i_abc123",
    "platform": "cursor",
    "context_key": "eyJhbGciOiJFZERTQSIs..."
  },
  "timeline_window": {
    "last_n": 20,
    "domains": ["coding"]
  }
}
```

**Response:**

```json
{
  "usrcp_version": "0.1.0",
  "user_id": "usrcp://ledger.usrcp.dev/u_7f3a9b2c",
  "resolved_at": "2026-04-19T01:30:00Z",
  "cache_hint": {
    "ttl_seconds": 300,
    "etag": "W/\"a1b2c3d4\""
  },
  "state": {
    "core_identity": {
      "display_name": "Frank",
      "roles": ["founder", "software_engineer"],
      "expertise_domains": [
        { "domain": "ai_systems", "level": "expert" },
        { "domain": "typescript", "level": "advanced" },
        { "domain": "react", "level": "intermediate" }
      ],
      "communication_style": "concise"
    },
    "global_preferences": {
      "language": "en",
      "timezone": "America/Los_Angeles",
      "output_format": "markdown",
      "verbosity": "minimal"
    },
    "recent_timeline": [
      {
        "event_id": "01JSGK3N7XRZQ4BVHP2M6T8W",
        "timestamp": "2026-04-18T22:15:00Z",
        "platform": "claude_code",
        "domain": "coding",
        "summary": "Built USRCP protocol specification and repo structure",
        "intent": "Create foundational architecture for User Context Protocol",
        "outcome": "success"
      }
    ]
  }
}
```

**Scope resolution rules:**
- Agents only receive state for domains their context key authorizes
- `core_identity` and `global_preferences` are readable by any authenticated agent
- `recent_timeline` is filtered by the agent's authorized domains
- `domain_context` requires explicit domain-level read permission

### 3.2 `append_event`

**Request:**

```json
{
  "usrcp_version": "0.1.0",
  "method": "append_event",
  "user_id": "usrcp://ledger.usrcp.dev/u_7f3a9b2c",
  "requesting_agent": {
    "agent_id": "agent://cursor/code-assistant/i_abc123",
    "platform": "cursor",
    "context_key": "eyJhbGciOiJFZERTQSIs..."
  },
  "event": {
    "domain": "coding",
    "summary": "Refactored auth middleware to use JWT validation",
    "intent": "Improve security of API authentication layer",
    "outcome": "success",
    "detail": {
      "language": "typescript",
      "files_modified": ["src/auth.ts", "src/middleware.ts"],
      "commit_sha": "a1b2c3d"
    },
    "artifacts": [
      {
        "type": "git_commit",
        "ref": "https://github.com/user/repo/commit/a1b2c3d",
        "label": "Auth refactor commit"
      }
    ],
    "tags": ["security", "refactor", "auth"]
  },
  "idempotency_key": "idem_20260419_001"
}
```

**Response:**

```json
{
  "usrcp_version": "0.1.0",
  "status": "accepted",
  "event_id": "01JSGK4P8YSAQ5CWJQ3N7U9X",
  "timestamp": "2026-04-19T01:35:00Z",
  "ledger_sequence": 4721
}
```

**Write constraints:**
- Agents can only append to domains their context key authorizes for `append` permission
- Events are immutable once written — corrections are new events with `parent_event_id`
- Rate limit: 100 events/minute per agent per user (configurable by ledger operator)
- `idempotency_key` prevents duplicate writes within a 24-hour window

### 3.3 `sync` *[PLANNED]* (v0.2.0)

Bi-directional state reconciliation over WebSocket. Enables real-time cross-platform continuity. Specified in a future revision.

---

## 4. Authentication Handshake

### 4.1 Flow

```
Agent                          Ledger                         User
  |                              |                              |
  |-- register_agent ----------->|                              |
  |   (agent_id, scopes,         |                              |
  |    public_key)                |                              |
  |                              |-- approval_request --------->|
  |                              |   (agent_name, scopes,       |
  |                              |    justification)             |
  |                              |                              |
  |                              |<-- approve/deny -------------|
  |                              |                              |
  |<-- context_key --------------|                              |
  |   (JWT, granted_scopes,      |                              |
  |    refresh_token)            |                              |
  |                              |                              |
  |== Subsequent requests use context_key as bearer ===========>|
```

### 4.2 Context Key Format

The context key is a JWT (EdDSA-signed by the ledger) containing:

```json
{
  "iss": "usrcp://ledger.usrcp.dev",
  "sub": "usrcp://ledger.usrcp.dev/u_7f3a9b2c",
  "aud": "agent://cursor/code-assistant/i_abc123",
  "iat": 1745024100,
  "exp": 1745110500,
  "scopes": [
    { "domain": "coding", "permissions": ["read", "append"] },
    { "domain": "global_preferences", "permissions": ["read"] }
  ],
  "jti": "ctx_a1b2c3d4e5f6"
}
```

### 4.3 Request Signing

For high-security deployments, agents sign requests with their Ed25519 private key:

```
USRCP-Signature: t=1745024100,v1=<base64url(Ed25519(request_body))>
```

The ledger verifies against the agent's registered public key. This prevents context key theft from being exploitable without the private key.

---

## 5. Latency Architecture — Sub-50ms Handshake *[PLANNED — hosted ledger]*

The critical constraint: USRCP must not bottleneck LLM generation. A `get_state` call that adds 200ms before the first token is a protocol that won't get adopted.

### 5.1 Strategy: Edge-Cached State + Stale-While-Revalidate

```
Agent                     Edge PoP                    Origin Ledger
  |                          |                              |
  |-- get_state ------------>|                              |
  |   + context_key          |                              |
  |   + If-None-Match: etag  |                              |
  |                          |                              |
  |<-- 200 OK (from cache) --|     (async revalidate) ----->|
  |   ~5-15ms                |                              |
  |                          |<-- fresh state --------------|
  |                          |   (update cache)             |
```

**How it works:**

1. **Edge caching**: User state is cached at edge PoPs (Cloudflare Workers / Fly.io edge). The cache key is `(user_id, context_key_hash, scope_set)`.

2. **Stale-while-revalidate**: Serve cached state immediately. Revalidate asynchronously. For user preferences and identity, staleness of 30-60 seconds is acceptable.

3. **Conditional requests**: Agents include `If-None-Match` with the etag from the last response. If state hasn't changed, the edge returns `304 Not Modified` in <5ms.

4. **Hot path optimization**: `core_identity` and `global_preferences` change rarely. These are served from edge with aggressive TTLs (5-15 minutes). `recent_timeline` has shorter TTLs (30-60 seconds).

### 5.2 Latency Budget

| Component | Target | Mechanism |
|-----------|--------|-----------|
| TLS handshake | 0ms | Connection reuse / HTTP/2 multiplexing |
| Edge cache lookup | 1-3ms | In-memory KV at edge PoP |
| JWT validation | 1-2ms | EdDSA verification at edge |
| Scope filtering | 1-2ms | Filter cached state by context key scopes |
| Response serialization | 1-2ms | Pre-serialized cached responses |
| **Total (cache hit)** | **5-10ms** | |
| **Total (cache miss)** | **30-80ms** | Origin fetch + cache population |

### 5.3 Client-Side Prefetch

SDKs implement **predictive prefetch**: when an agent session starts, immediately issue a `get_state` for likely-needed scopes. By the time the LLM needs user context, it's already in local memory.

```typescript
// SDK auto-prefetch on session init
const usrcp = new USRCPClient({ userId, contextKey });
// This fires immediately, non-blocking
usrcp.prefetch(["core_identity", "global_preferences", "recent_timeline"]);

// Later, when the LLM needs context — instant, from local cache
const state = await usrcp.getState(["core_identity"]);
// resolves in <1ms from prefetch cache
```

### 5.4 Write Path

`append_event` is fire-and-forget from the agent's perspective:

1. Agent sends event
2. Edge PoP responds `202 Accepted` immediately (~5ms)
3. Event is durably queued and written to the ledger asynchronously
4. Ledger assigns `event_id` and `ledger_sequence` — available on next `get_state`

This means writes never block the agent's main loop.

---

## 6. Wire Format Summary

| Header | Value | Required |
|--------|-------|----------|
| `Content-Type` | `application/json` | Yes |
| `Authorization` | `Bearer <context_key>` | Yes |
| `USRCP-Version` | `0.1.0` | Yes |
| `USRCP-Signature` | `t=<timestamp>,v1=<sig>` | Optional |
| `If-None-Match` | `<etag>` | Optional |

Base URL: `https://<ledger_host>/v1/`

| Endpoint | Method | Operation |
|----------|--------|-----------|
| `/v1/state` | GET | `get_state` (scopes as query params) |
| `/v1/events` | POST | `append_event` |
| `/v1/sync` | WebSocket | `sync` (v0.2.0) |
| `/v1/agents/register` | POST | Agent registration |
| `/v1/tokens/refresh` | POST | Token refresh |

---

## 7. Concurrency Model

USRCP does not assume a single writer per user. Multiple agents (across
devices or within one device) may write concurrently. The semantics below
define how each table handles overlapping writes. None of these require
CRDTs or vector clocks in v0.x — last-write-wins and monotonic sequences
cover all current workloads.

### 7.1 Timeline events — append-only, no conflict

Every `append_event` mints a fresh ULID and a monotonic `ledger_sequence`.
Because no row is ever updated, concurrent writers cannot collide. Ordering
across writers is determined by `ledger_sequence`; timestamps are
descriptive, not authoritative. An agent that cares about total order
across devices must use `ledger_sequence`, not `timestamp`.

### 7.2 Identity, preferences, domain context, schemaless facts — last-write-wins

These tables store a single current value per field (or per key). When two
writers update the same record, the later write wins and the earlier write
is silently lost. Each affected table carries an integer `version` column
that the ledger increments on every successful write. The `updated_at`
timestamp is the secondary tiebreaker for human inspection only; clients
must not rely on it for correctness.

Tables covered:

| Table | Unit of LWW |
|-------|-------------|
| `core_identity` | whole row (singleton) |
| `global_preferences` | whole row (singleton) |
| `domain_context` | per `domain` |
| `schemaless_facts` | per `(domain, namespace, key)` |

Active projects also last-write-wins on the row, with `last_touched` as
the tiebreaker (no `version` column — Phase-2 work if needed).

### 7.3 Optimistic concurrency — `expected_version`

Agents that require read-modify-write semantics must pass the
`expected_version` they read back on the corresponding write. If the stored
`version` has advanced in the interim, the write is rejected with
`VERSION_CONFLICT` (HTTP 409) and the caller must re-read and retry.

`expected_version` is **optional**. Omitting it retains the default
last-write-wins behavior; existing clients built against v0.1 continue to
work unchanged.

For tables where a key may not yet exist (`domain_context`,
`schemaless_facts`), `expected_version=0` means "no row exists" — succeeds
on the first write and conflicts on a concurrent insert from another
writer.

Supported endpoints/tools:

- `usrcp_update_identity`
- `usrcp_update_preferences`
- `usrcp_update_domain_context`
- `usrcp_set_fact`

A `VERSION_CONFLICT` response includes the current server version so the
caller can decide whether to re-read, merge, and retry, or surface the
conflict to the user:

```json
{
  "status": "version_conflict",
  "error": "VERSION_CONFLICT",
  "scope": "global_preferences",
  "target": null,
  "current_version": 7,
  "expected_version": 5,
  "message": "Version conflict on global_preferences — expected v5, current is v7"
}
```

### 7.4 What USRCP does **not** do in v0.x

- **No CRDTs.** Strings and records are opaque; no automatic merge.
- **No vector clocks.** Single logical ledger per user; `version` + ULID suffice.
- **No automatic retry.** Callers re-read and retry at the application layer.
- **No multi-writer timeline merge.** `ledger_sequence` is locally monotonic; global ordering across devices is a Phase-2 concern for the hosted ledger (see task 06).

---

## 8. Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_CONTEXT_KEY` | 401 | Context key expired, revoked, or malformed |
| `SCOPE_DENIED` | 403 | Requested scope not granted to this agent |
| `USER_NOT_FOUND` | 404 | User ID does not exist on this ledger |
| `RATE_LIMITED` | 429 | Too many requests — retry after `Retry-After` header |
| `LEDGER_UNAVAILABLE` | 503 | Origin ledger is down — edge may serve stale cache |
| `IDEMPOTENCY_CONFLICT` | 409 | Event with this idempotency key already exists |
| `VERSION_CONFLICT` | 409 | `expected_version` did not match the current server version — re-read and retry |
