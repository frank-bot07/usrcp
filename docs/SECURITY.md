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

#### Rotation and tampered rows

Rotation re-encrypts every ciphertext column under the new master key. Most rows
round-trip cleanly, but a row whose ciphertext fails GCM authentication during
rotation is unrecoverable — the plaintext cannot be produced, so it cannot be
re-encrypted. Causes include deliberate tampering, on-disk corruption, or a row
written by a key that no longer matches (e.g. a partial restore).

When this happens:

- The row is **left in place** under its old ciphertext and old domain pseudonym.
  It is not silently dropped, so external audits of the raw database can still
  observe that a tampered row exists.
- Rotation **does not abort**. The remaining rows are re-encrypted as normal.
- Each skipped row is counted in the `skipped` field of the rotation result,
  alongside `reencrypted`.
- A `key_rotation_skipped` audit-log entry records the total skipped count.
- Under the new master key, skipped rows remain unreadable: reads surface them
  with tampered-field markers rather than crashing the whole timeline. The blind
  index has no tokens for them, so keyword search will not match.

**Legacy plaintext rows** (predating domain-scoped encryption) are not
considered damaged — they are treated as plaintext, encrypted under the new
domain key, and become first-class ciphertext rows from that point on.

---

## 3. Searchable Encryption

### Architecture decision: exact-keyword, not semantic

USRCP's search is **exact keyword matching over an HMAC blind index**.
There are no embeddings, no vector similarity, and no semantic recall.
This is a deliberate architectural choice, not an omission. See
[strategy/SEARCH_DECISION.md](../strategy/SEARCH_DECISION.md) for the
full tradeoff analysis. Briefly:

- **Embeddings leak semantic structure even when encrypted.** Two
  records with similar plaintext produce similar embeddings; a compromised
  master key turns the encrypted index into a semantic similarity oracle
  over every record, not a per-record decryption attack. Blind indexes
  do not have this property — a compromised blind-index key reveals
  keyword membership but does not reveal semantic clustering.
- **Exact keyword matching is sufficient for structured state.** Queries
  like "find events tagged `auth` in the `coding` domain" are the
  intended shape of USRCP search. Fuzzy recall over conversational
  history is the job of a separate semantic memory layer; callers are
  free to run one in parallel.

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

### What blind index does NOT provide

- **Semantic similarity.** "anxiety medication" and "sertraline dosage" do
  not match each other unless they share a token. This is by design — see
  the architecture decision above.
- **Ranking.** Matching is boolean per token; there is no TF-IDF score.
  If ranking is needed, callers should fetch all matches and sort
  application-side (e.g., by timestamp).
- **Typo tolerance.** "authenication" will not match "authentication"
  because their n-grams differ. Fuzzy matching would require either
  normalized tokens on write (reducing the search space) or a separate
  fuzzy-match layer that USRCP deliberately does not supply.

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

## 7. Runtime Hardening

### Buffer zeroing

All intermediate Buffers in encrypt/decrypt paths are zeroed after use via `Buffer.fill(0)`. This includes cipher update/final buffers, packed ciphertext, HMAC digests, and the master key on shutdown. This reduces the window for heap extraction but does not eliminate it — see Known Limitations.

### scrypt cost parameters

Key derivation uses hardened scrypt parameters: N=131072 (2^17), r=8, p=2. At these settings, each derivation takes ~200-500ms on modern hardware. Brute-forcing a 12+ character passphrase requires years on consumer hardware (including M2 Max).

### Passphrase side-channel mitigation

- `USRCP_PASSPHRASE` env var is preferred over `--passphrase` CLI flag
- CLI flag warns that the passphrase is visible in `/proc/<pid>/cmdline`
- Env var is deleted from `process.env` immediately after reading
- Passphrase is never logged or echoed

---

## 8. Known Limitations & Threat Model Boundaries

### What this system protects against

- **Disk theft / backup exposure**: All data encrypted at rest. In passphrase mode, no key file exists on disk.
- **Unauthorized agent access**: Domain-scoped keys prevent cross-domain data access.
- **Forensic recovery of deleted data**: `secure_delete` pragma + VACUUM zero-fill deleted pages.
- **Frequency analysis of search index**: Noise tokens mixed with real blind index tokens.

### What this system does NOT protect against

- **Heap extraction (`gcore <PID>` + `strings`)**: A local attacker with root can dump process memory and extract the master key, derived keys, and any decrypted plaintext currently in the V8 heap. All Buffers we control are zeroed after use, but JavaScript strings are immutable and GC-managed — once plaintext becomes a string, we cannot zero it. **Mitigation for Pro/Enterprise: Rust or Go sidecar for decryption in a memory-safe runtime, or TEE (Trusted Execution Environment).**

- **Debugger attachment (`ptrace`, `lldb`)**: A local attacker can attach a debugger to the running process and read any value in memory. No Node.js mitigation exists. **Mitigation: Run with `ptrace` disabled via `prctl(PR_SET_DUMPABLE, 0)` on Linux, or use a sandboxed runtime.**

- **No FIPS 140-2**: Node.js `crypto` uses OpenSSL but is not FIPS certified. Regulated industries requiring FIPS compliance need a certified crypto module.

- **No HSM**: Keys are software-managed. Hardware Security Module integration would require native bindings to PKCS#11 or platform-specific APIs.

- **stdio transport (default)**: MCP communication is unencrypted plaintext over stdio. Any process that can read the pipe — or any local attacker that can attach to the spawning client or the server — sees decrypted data in transit. This is the default because MCP clients (Claude Desktop, Claude Code) auto-spawn the server over stdio and the UX is frictionless. **Mitigation: run `usrcp init --transport=http` and `usrcp serve --transport=http` for a TLS + bearer-authenticated HTTPS transport (see §9).**

- **Timestamps remain plaintext**: Activity timing patterns are visible. An attacker knows when the user was active but not what they did.

- **V8 string immutability**: JavaScript strings cannot be zeroed. Decrypted field values (summaries, intents, etc.) persist as V8 strings until garbage collected. The GC does not zero freed heap pages.

### Enterprise mitigation roadmap

For Pro/Enterprise tiers where the threat model includes local attackers with root:

1. **Rust decryption sidecar**: Move all encrypt/decrypt operations to a Rust process that communicates with the Node.js server via a Unix socket. Rust provides guaranteed memory zeroing via `zeroize` crate.
2. **TEE integration**: Run the decryption sidecar inside an Intel SGX or ARM TrustZone enclave. The master key never exists in normal process memory.
3. **Authenticated MCP transport**: Available today — see §9.
4. **FIPS mode**: Use a FIPS-validated OpenSSL build or BoringSSL with the Rust sidecar.

---

## 9. Authenticated HTTPS Transport (opt-in)

`usrcp serve --transport=http` runs the MCP server over HTTPS on
`127.0.0.1`, gated by a 32-byte bearer token. This closes the plaintext-
over-stdio gap described in §8, at the cost of requiring the server to
be running as a standalone process (stdio's auto-spawn convenience goes
away).

### What it does

- **Self-signed TLS certificate**: Generated once at
  `~/.usrcp/users/<slug>/tls/{cert,key}.pem`, mode `0600`, RSA-2048 with
  SHA-256 signature, SAN covering `localhost` and `127.0.0.1`. Valid 1
  year; regenerate by deleting and restarting `serve`. **Not a public-CA
  cert** — clients must pin this cert or otherwise trust it explicitly.
- **Bearer token**: 32 bytes of `crypto.randomBytes`, stored hex-encoded
  at `~/.usrcp/users/<slug>/auth.token`, mode `0600`. Compared with
  `crypto.timingSafeEqual` on every request.
- **Scope**: Listens on `127.0.0.1` only — not on external interfaces.
  The cert's SAN reflects that; the server rejects any non-TLS request.

### What it does not do

- **Does not trust any CA.** The cert is self-signed and uniquely tied
  to this install. Clients that don't pin it must use
  `rejectUnauthorized: false` scoped to this endpoint; that weakens the
  TLS story but is acceptable for `127.0.0.1` because the network path
  is not attacker-reachable.
- **Does not prevent local heap extraction.** The same limitations from
  §8 apply — a local attacker with root who can attach to either end
  of the connection still sees plaintext in process memory.
- **Does not rotate tokens.** Delete `auth.token`, restart the server,
  and the next `ensureAuthToken()` call generates a new one. Update
  dependents manually.

### Registering the transport with an MCP client

`usrcp init --transport=http` writes an HTTP-style entry to Claude
Desktop's config:

```json
"usrcp": {
  "type": "http",
  "url": "https://127.0.0.1:9876/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

The user is responsible for running the server (the client won't spawn
it). Typical options: `usrcp serve --transport=http` in a dedicated
shell, or a launchd/systemd service. Registered entries auto-spawn
only under the stdio-style `{ command, args }` form.
