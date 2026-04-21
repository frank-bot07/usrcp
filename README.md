# USRCP — User Context Protocol

**Structured, encrypted user state for AI agents. Cross-platform, ledger-style, zero-knowledge.**

AI agents today rebuild their understanding of the user every session: your stack, your preferences, your active projects, your timezone. Claude Desktop doesn't know what you told Cursor. Cursor doesn't know what Cline pulled from git this morning. The structured facts an agent needs to be useful on day two — identity, preferences, projects, interaction timeline — are fragmented across platforms, sessions, and devices.

USRCP is a cross-platform protocol for reading, writing, and syncing **structured user state** across AI agents, with all data encrypted at rest under a key the user controls.

> **What USRCP is not.** USRCP is **not** a semantic memory layer. It doesn't do vector search, embeddings, or fuzzy conversational recall. If you ask "what did I tell you about my anxiety meds last week?" USRCP won't find that unless you stored it as a structured fact. For fuzzy recall over chat transcripts, use Mem0 or Zep — they solve a different problem. See [What USRCP is vs. isn't](#what-usrcp-is-vs-isnt) below.

## Protocol Stack

```
┌─────────────────────────────────┐
│         Agent Layer             │  ← ACP (Agent-to-Agent)
├─────────────────────────────────┤
│         Model Layer             │  ← MCP (Model Context Protocol)
├─────────────────────────────────┤
│     >>> USRCP <<<               │  ← Structured User State (THIS PROTOCOL)
├─────────────────────────────────┤
│         User / Client           │
└─────────────────────────────────┘
```

## What USRCP is vs. isn't

|                              | USRCP                                          | Mem0 / Zep (semantic memory)          |
| ---------------------------- | ---------------------------------------------- | ------------------------------------- |
| **Storage model**            | Structured schema + encrypted schemaless facts | Opaque vector blobs                   |
| **Search**                   | Exact keyword via HMAC blind index             | Semantic similarity via embeddings    |
| **Representative query**     | "What is the user's timezone and framework?"   | "What did the user feel last week?"   |
| **Does the server see plaintext?** | No. Ever.                                | Yes — at embed time.                  |
| **Cross-device sync**        | Zero-knowledge (hosted ledger stores ciphertext only) | Provider-trusted                |
| **Use case**                 | Cross-platform persistent state for agents     | Conversational recall over history    |
| **Audit log**                | Cryptographically signed, encrypted            | Provider-managed                      |

**USRCP is the right choice when:**
- You need identity, preferences, or project state to flow between Claude Desktop, Cursor, Continue, Cline, etc.
- You're in a regulated industry (health, finance, legal) where a memory provider seeing plaintext is a non-starter.
- You want users to own the encryption key, not the memory vendor.

**Semantic memory (Mem0/Zep) is the right choice when:**
- You want fuzzy recall over free-form chat history.
- You're building a consumer product where "remind me what I said about X" is the core feature.
- The user trusts the memory provider with plaintext.

The two are complementary, not competitive. Nothing stops an agent from using both.

## Quickstart

Once published to npm, one line will do it:

```bash
npx usrcp init
```

Until then, from a clone:

```bash
cd packages/usrcp-local
npm install && npm run build && npm link

# Interactive init — prompts for passphrase by default
usrcp init

# Non-interactive:
usrcp init --passphrase "your secret phrase"       # passphrase mode
usrcp init --dev                                     # dev mode (key on disk)

# Start the server (passphrase mode requires env var)
USRCP_PASSPHRASE="your secret phrase" usrcp serve
```

`init` creates `~/.usrcp/users/<slug>/` with an encrypted SQLite ledger and
writes the MCP server entry to Claude Desktop's config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Multiple users on one machine

```bash
usrcp init --user=frank
usrcp init --user=jess
usrcp serve --user=frank   # or rely on --user in the registered MCP entry
usrcp users                # list available slugs
```

Each user gets an independent ledger, passphrase, and MCP server entry.

## What's Encrypted

**Everything.** An attacker reading the SQLite file sees:

| Column | What they see |
|--------|--------------|
| `event_id` | Opaque ULID |
| `timestamp` | When (not what) |
| `domain` | HMAC pseudonym (`d_1ac6397ab4d2`) |
| `summary` | `enc:base64ciphertext...` |
| `intent` | `enc:base64ciphertext...` |
| `outcome` | `enc:base64ciphertext...` |
| `platform` | `enc:base64ciphertext...` |
| `detail` | `enc:base64ciphertext...` |
| `tags` | `enc:base64ciphertext...` |
| `audit_log.*` | `enc:base64ciphertext...` |

In passphrase mode, no key file exists on disk. The key is derived via scrypt on startup and zeroed on shutdown.

## MCP Tools (12)

| Tool | Description |
|------|-------------|
| `usrcp_get_state` | Query identity, preferences, projects, timeline |
| `usrcp_append_event` | Record an interaction event |
| `usrcp_update_identity` | Update user roles, expertise, communication style (with optional `expected_version` for read-modify-write) |
| `usrcp_update_preferences` | Update language, timezone, verbosity |
| `usrcp_update_domain_context` | Store domain-scoped key-value context |
| `usrcp_set_fact` | Store a free-form schemaless fact under `(domain, namespace, key)` |
| `usrcp_get_facts` | Read one fact or list all facts in a domain / namespace |
| `usrcp_search_timeline` | Search via blind index tokens (exact keyword, not semantic) |
| `usrcp_manage_project` | Create/update tracked projects |
| `usrcp_audit_log` | View encrypted audit trail |
| `usrcp_rotate_key` | Rotate master encryption key (re-encrypts all data) |
| `usrcp_status` | Ledger stats and health |

## Security Architecture

- **AES-256-GCM** encryption at rest for all fields
- **Domain-scoped keys** via HKDF-SHA256 — coding key cannot decrypt health data
- **scrypt** passphrase derivation (N=16384, r=8, p=1) — key never on disk
- **HMAC domain pseudonyms** — domain names are opaque identifiers
- **Blind index search** with n-gram tokens and noise injection
- **Encrypted audit log** — access patterns are ciphertext
- **Atomic key rotation** — re-encrypts all data in a single transaction
- **secure_delete pragma** — SQLite zero-fills deleted pages
- **Master key zeroed** on process shutdown

## Project Structure

```
usrcp/
├── spec/PROTOCOL.md               # Protocol specification
├── schemas/                        # JSON schemas (get_state, append_event, handshake)
├── docs/SECURITY.md                # Security & privacy model
├── strategy/
│   ├── GTM.md                      # Go-to-market strategy
│   └── PITCH.md                    # Investor executive summary
└── packages/usrcp-local/           # Local MCP server
    ├── src/
    │   ├── index.ts                # CLI (init/serve/status + passphrase)
    │   ├── server.ts               # 10 MCP tools
    │   ├── ledger.ts               # Encrypted SQLite operations
    │   ├── encryption.ts           # AES-256-GCM, scrypt, blind index
    │   ├── crypto.ts               # Ed25519 identity keys
    │   ├── types.ts                # TypeScript types
    │   └── __tests__/              # 137 tests
    └── package.json
```

## Tests

```bash
cd packages/usrcp-local
npm test        # 211 tests in local + 25 in packages/usrcp-cloud
```

Coverage: ledger CRUD, crypto, MCP server, security boundaries, encryption roundtrip / tamper / domain isolation, audit log, ULID, pruning, multi-user isolation, optimistic concurrency / version conflicts, schemaless facts, HTTPS+bearer transport, sync push/pull, Ed25519 signed-request auth.

## Business Model

Open-source protocol (Apache 2.0). The reference implementation is free and local-first. Revenue comes from the hosted ledger — cross-device sync, team ledgers, compliance-grade audit features — all operating on ciphertext only.

The wedge isn't "every AI-using human." It's **security-conscious developers and regulated enterprises** who can't ship AI memory that phones a third party with plaintext. See [strategy/PITCH.md](strategy/PITCH.md) and [strategy/GTM.md](strategy/GTM.md) for the full positioning.

## License

Apache 2.0
