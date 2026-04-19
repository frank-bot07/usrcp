# USRCP Security & Privacy Model

**Scoped Context Keys, Encryption Architecture, and Domain Isolation**

---

## 1. Threat Model

USRCP aggregates a user's cross-platform AI interaction history into a single ledger. This creates a high-value target. The security model must ensure:

1. **Domain isolation** — A coding agent cannot read therapy bot logs
2. **Agent containment** — A compromised agent cannot escalate its access
3. **User sovereignty** — The user controls what is stored and who can read it
4. **Forward secrecy** — Revoking an agent's access makes past-granted data unreadable
5. **Ledger integrity** — Events cannot be tampered with post-write

---

## 2. Scoped Context Keys

This is the core innovation. Context keys are not simple API tokens — they are **cryptographically scoped access grants** that enforce domain isolation at the protocol level.

### 2.1 Architecture

```
User's Ledger State
├── core_identity          ← readable by ALL authenticated agents
├── global_preferences     ← readable by ALL authenticated agents
├── domain: coding         ← encrypted with domain key K_coding
│   ├── timeline events
│   └── domain context
├── domain: writing        ← encrypted with domain key K_writing
├── domain: health         ← encrypted with domain key K_health (HIGH sensitivity)
├── domain: finance        ← encrypted with domain key K_finance (HIGH sensitivity)
└── domain: personal       ← encrypted with domain key K_personal
```

### 2.2 How It Works

Each domain has its own symmetric encryption key (`K_domain`), derived from the user's master key:

```
K_domain = HKDF-SHA256(
  ikm = user_master_key,
  salt = domain_name,
  info = "usrcp-domain-key-v1"
)
```

When a user approves an agent for a domain, the ledger wraps `K_domain` with the agent's public key:

```
wrapped_key = X25519(agent_public_key, K_domain)
```

This wrapped key is embedded in the agent's context key JWT as an encrypted claim. The agent can decrypt domain data, but only for its authorized domains.

### 2.3 Why a Coding Agent Can't Read Therapy Logs

```
Cursor (coding agent):
  context_key contains: wrapped(K_coding)
  CAN read:  core_identity, global_preferences, domain:coding
  CANNOT read: domain:health, domain:personal, domain:finance

Therapy Bot:
  context_key contains: wrapped(K_health)
  CAN read:  core_identity, global_preferences, domain:health
  CANNOT read: domain:coding, domain:finance, domain:personal
```

This is enforced cryptographically, not just by access control lists. Even if the ledger is compromised, an attacker with Cursor's context key cannot decrypt health domain data — they don't have `K_health`.

### 2.4 Sensitivity Tiers

Domains are classified into sensitivity tiers that control defaults:

| Tier | Domains | Default Behavior |
|------|---------|-----------------|
| **Standard** | coding, writing, research | Readable by agents approved for that domain |
| **Elevated** | personal, work | Requires explicit per-agent approval |
| **Restricted** | health, finance, legal | Requires MFA confirmation + per-agent approval. Events are client-side encrypted before reaching the ledger |

---

## 3. Encryption Architecture

### 3.1 Layers

```
┌──────────────────────────────────────────────────┐
│ Layer 3: Transport Encryption (TLS 1.3)          │  ← wire security
├──────────────────────────────────────────────────┤
│ Layer 2: Domain Encryption (AES-256-GCM)         │  ← domain isolation
│   Key: K_domain (per-domain, per-user)           │
├──────────────────────────────────────────────────┤
│ Layer 1: Client-Side Encryption (XChaCha20)      │  ← restricted tier only
│   Key: K_client (never leaves user's device)     │  ← zero-knowledge
└──────────────────────────────────────────────────┘
```

### 3.2 At Rest

- **Standard/Elevated tiers**: Events are encrypted with `K_domain` at the ledger. The ledger operator can decrypt if they have the domain key (necessary for server-side filtering and search).
- **Restricted tier**: Events are encrypted client-side with `K_client` before transmission. The ledger stores opaque ciphertext. **Zero-knowledge** — the ledger operator cannot read restricted-tier events.

### 3.3 Key Hierarchy

```
user_master_secret (Argon2id-derived from passphrase, or hardware key)
  │
  ├── K_identity    = HKDF(master, "identity")     — signs user operations
  ├── K_coding      = HKDF(master, "coding")        — domain key
  ├── K_health      = HKDF(master, "health")        — domain key
  ├── K_client      = HKDF(master, "client-e2ee")   — client-side encryption
  └── K_recovery    = Shamir split (3-of-5)          — recovery shards
```

### 3.4 Key Rotation

Domain keys can be rotated without re-encrypting the entire ledger:

1. Generate new `K_domain_v2`
2. New events use `K_domain_v2`
3. Old events retain `K_domain_v1` (immutable ledger)
4. Context keys issued after rotation include `K_domain_v2`
5. Old context keys continue working for historical reads (they still have `K_domain_v1`)

---

## 4. Agent Authentication & Authorization

### 4.1 Registration Flow

1. Agent generates Ed25519 keypair
2. Agent sends registration request with public key and requested scopes
3. User approves/denies via ledger UI (web, CLI, or in-app prompt)
4. Ledger issues context key JWT containing:
   - Granted scopes
   - Wrapped domain keys for authorized domains
   - Expiry (default: 24 hours, configurable)
   - Refresh token (default: 30 days)

### 4.2 Request Authentication

Every request includes:

```
Authorization: Bearer <context_key_jwt>
```

Optional (for high-security):

```
USRCP-Signature: t=<unix_ts>,v1=<Ed25519(timestamp + request_body)>
```

The signature binds the request to the agent's private key. Even if the JWT is stolen, the attacker cannot forge requests without the private key.

### 4.3 Revocation

- **Immediate**: User revokes agent access via ledger UI. Revocation is pushed to edge caches within 5 seconds.
- **Context key blocklist**: Revoked JTIs are stored in a compact Bloom filter at edge PoPs for O(1) rejection.
- **Domain key re-wrap**: On revocation, the domain key is re-wrapped for remaining authorized agents. The revoked agent's wrapped key is deleted.

---

## 5. Privacy Controls

### 5.1 User Rights

| Right | Implementation |
|-------|---------------|
| **Right to Read** | `get_state` with `scope: ["*"]` and user's master context key |
| **Right to Delete** | Tombstone events in ledger + purge from edge cache |
| **Right to Revoke** | Instant agent revocation + key re-wrap |
| **Right to Export** | Full ledger export in USRCP JSON format |
| **Right to Migrate** | Signed migration record to move to a new ledger host |

### 5.2 Data Minimization

- Agents declare why they need each scope (`justification` field)
- The SDK warns developers if they request more scopes than they use
- `recent_timeline` events are auto-summarized after 30 days — raw detail is pruned, summary is retained

### 5.3 Audit Log

Every access is logged:

```json
{
  "timestamp": "2026-04-19T01:30:00Z",
  "agent_id": "agent://cursor/code-assistant/i_abc123",
  "operation": "get_state",
  "scopes_accessed": ["core_identity", "recent_timeline:coding"],
  "cache_hit": true,
  "response_size_bytes": 2048
}
```

Users can review the audit log to see exactly which agents accessed what data and when.

---

## 6. Attack Surface & Mitigations

| Attack | Mitigation |
|--------|-----------|
| **Stolen context key** | Short expiry (24h) + optional request signing. Revocation propagates in <5s |
| **Compromised ledger** | Domain encryption means attacker gets ciphertext. Restricted tier is zero-knowledge |
| **Rogue agent over-requesting** | Scope justification shown to user. SDK flags unused scopes. Rate limiting |
| **Cross-domain leakage** | Cryptographic domain isolation. No access control bypass possible without domain key |
| **Replay attacks** | Nonce in USRCP-Signature + idempotency keys. Timestamp window: 5 minutes |
| **Man-in-the-middle** | TLS 1.3 mandatory. Certificate pinning in SDK. HSTS on ledger endpoints |
| **Ledger operator snooping** | Restricted tier uses client-side encryption. Operator sees opaque blobs |
