# USRCP Technical Specification v0.1.0

**User Context Protocol — Wire Format, Authentication, and Latency Architecture**

> **Implementation status**: The `usrcp-local` MCP server implements the core
> operations (`get_state`, `append_event`) with full encryption at rest,
> blind index search, encrypted audit logging, scrypt key derivation, and
> atomic key rotation. See `docs/SECURITY.md` for the implemented encryption
> architecture. Sections marked *[PLANNED]* describe hosted ledger features
> not yet implemented.

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

## 7. Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_CONTEXT_KEY` | 401 | Context key expired, revoked, or malformed |
| `SCOPE_DENIED` | 403 | Requested scope not granted to this agent |
| `USER_NOT_FOUND` | 404 | User ID does not exist on this ledger |
| `RATE_LIMITED` | 429 | Too many requests — retry after `Retry-After` header |
| `LEDGER_UNAVAILABLE` | 503 | Origin ledger is down — edge may serve stale cache |
| `IDEMPOTENCY_CONFLICT` | 409 | Event with this idempotency key already exists |
