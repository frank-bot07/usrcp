# USRCP Security & Privacy Model

**Implemented encryption architecture for the local MCP server.**

---

## 1. Encryption at Rest

Every human-readable field in the database is encrypted with AES-256-GCM before storage. The only plaintext columns are structural: `event_id` (opaque ULID), `timestamp`, `ledger_sequence`, and domain pseudonyms.

### What's encrypted

| Table | Encrypted columns |
|-------|------------------|
| `timeline_events` | summary, intent, outcome, platform, detail, artifacts, tags, session_id, parent_event_id |
| `core_identity` | display_name, roles, expertise_domains, communication_style |
| `global_preferences` | timezone, custom |
| `domain_context` | context |
| `audit_log` | agent_id, operation, scopes_accessed, event_ids, detail |
| `domain_map` | encrypted_name |

### Domain pseudonyms

The `domain` column in `timeline_events` and `domain_context` stores HMAC-SHA256 pseudonyms (e.g., `d_1ac6397ab4d2`), not real domain names. The `domain_map` table maps pseudonyms to encrypted real names. An attacker sees opaque identifiers — they cannot determine whether a user has "health" or "finance" domains.

---

## 2. Key Architecture

### Two modes

**Passphrase mode** (production):
```
User passphrase
  → scrypt(N=16384, r=8, p=1) + stored salt
  → 32-byte master key (IN MEMORY ONLY)
  → HKDF per domain → domain encryption key
  → HKDF global → global encryption key
  → HKDF per domain → blind index key
```

On disk: `master.salt`, `master.verify` (HMAC hash for passphrase validation), `mode` file. **No key file.** The derived key exists only in process memory and is zeroed (`Buffer.fill(0)`) on shutdown.

**Dev mode** (local development):
```
Random 32-byte key → stored in master.key (0o600)
  → same HKDF derivation as above
```

### Key hierarchy

```
master_key (scrypt-derived or random)
  ├── global_key     = HKDF(master, "usrcp-global", "usrcp-encryption-v1")
  ├── domain_key[d]  = HKDF(master, "usrcp-domain-{d}", "usrcp-encryption-v1")
  └── blind_key[d]   = HKDF(master, "usrcp-blind-{d}", "usrcp-blind-index-v1")
```

Domain keys provide cryptographic isolation: a coding agent with access to `domain_key["coding"]` cannot derive `domain_key["health"]` without the master key.

### Key rotation

`Ledger.rotateKey()` atomically re-encrypts all data:
1. Generate new master key (from new passphrase or random)
2. In a single SQLite transaction: decrypt every field with old key, re-encrypt with new key
3. Rebuild blind index with new key material
4. Update key version file
5. Zero old key in memory

Exposed via `usrcp_rotate_key` MCP tool.

---

## 3. Searchable Encryption

### Blind index with n-gram tokens

Search over encrypted data uses HMAC-SHA256 blind index tokens:

1. On write: text is split into words. Each word generates:
   - A full-word HMAC token
   - Character n-gram tokens (3-6 chars) for prefix matching
   - 3 random noise tokens (defeats frequency analysis)
2. On search: query words are HMAC'd with the same key
3. Token matching finds events without exposing plaintext

Example: "authentication" generates tokens for `aut`, `auth`, `uthen`, `thent`, `henti`, `authentication`, etc. Searching "auth" matches because both the stored n-gram and the query produce the same HMAC.

### Frequency analysis resistance

Each event inserts 3 random 8-character hex tokens alongside real tokens. An attacker analyzing token frequency sees a mix of deterministic and random values with no way to distinguish them without the blind index key.

---

## 4. Audit Log

Every operation is logged to `audit_log` with encrypted fields:

| Field | Content |
|-------|---------|
| `timestamp` | Plaintext (when) |
| `agent_id` | Encrypted (who called) |
| `operation` | Encrypted (what operation) |
| `scopes_accessed` | Encrypted (which domains) |
| `event_ids` | Encrypted (which events) |
| `response_size_bytes` | Plaintext (how much data) |

The audit log is readable via the `usrcp_audit_log` MCP tool and `Ledger.getAuditLog()`, which decrypt fields with the global key.

---

## 5. Secure Deletion

- `secure_delete` pragma: SQLite zero-fills pages when rows are deleted
- `Ledger.secureWipe()`: WAL checkpoint + VACUUM after delete
- `Ledger.close()`: zeros master key buffer in memory
- Event pruning: writes encrypted empty values (not plaintext `'{}'`)

---

## 6. Input Validation

Defense-in-depth at two layers:

**Zod schemas** (MCP transport layer): max string lengths, max array sizes, bounded records.

**Ledger validation** (application layer): domain (100 chars), summary (500), intent (300), platform (100), tags (50 items), artifacts (50 items, 2048 ref), detail (64KB), idempotency_key (100), session_id (100).

---

## 7. Known Limitations

- **Node.js GC**: `zeroBuffer()` zeroes the Buffer, but V8's garbage collector does not guarantee immediate page zeroing for other allocations. Derived keys in HKDF intermediate buffers may persist in heap until GC reclaims.
- **No FIPS 140-2**: Node.js `crypto` uses OpenSSL but is not FIPS certified.
- **No HSM**: Keys are software-managed. Hardware Security Module integration would require platform-specific native bindings.
- **stdio transport**: MCP communication is unencrypted plaintext over stdio. Any process that can read the pipe sees decrypted data in transit.
- **Timestamps remain plaintext**: Activity timing patterns are visible.

These limitations require infrastructure changes (different runtime, HSM hardware, authenticated transport) that are outside the scope of a local MCP server.
