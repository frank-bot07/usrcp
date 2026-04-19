# USRCP — User Context Protocol

**The missing standard for human-to-AI memory.**

AI has an amnesia problem. Memory is siloed by session and platform. The industry solved model routing (MCP) and agent routing (ACP), but the **human layer** — preferences, history, identity — is entirely fragmented.

USRCP is a standardized, platform-agnostic protocol for AI systems to **query**, **append**, and **synchronize** a specific human's state across disparate systems via a lightweight handshake to a **User State Ledger**.

## Protocol Stack

```
┌─────────────────────────────────┐
│         Agent Layer             │  ← ACP (Agent-to-Agent)
├─────────────────────────────────┤
│         Model Layer             │  ← MCP (Model Context Protocol)
├─────────────────────────────────┤
│     >>> USRCP <<<               │  ← Human State (THIS PROTOCOL)
├─────────────────────────────────┤
│         User / Client           │
└─────────────────────────────────┘
```

## Quickstart

```bash
cd packages/usrcp-local
npm install && npm run build

# Dev mode (key stored on disk — for development)
node dist/index.js init

# Passphrase mode (key never touches disk — for production)
node dist/index.js init --passphrase "your secret phrase"

# Start the server (passphrase mode requires env var)
USRCP_PASSPHRASE="your secret phrase" node dist/index.js serve
```

This creates `~/.usrcp/` with an encrypted SQLite ledger and registers as an MCP server in Claude Code.

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

## MCP Tools (10)

| Tool | Description |
|------|-------------|
| `usrcp_get_state` | Query identity, preferences, projects, timeline |
| `usrcp_append_event` | Record an interaction event |
| `usrcp_update_identity` | Update user roles, expertise, communication style |
| `usrcp_update_preferences` | Update language, timezone, verbosity |
| `usrcp_update_domain_context` | Store domain-scoped key-value context |
| `usrcp_search_timeline` | Search via blind index tokens (prefix matching) |
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
npm test        # 137 tests across 7 suites
```

Suites: ledger CRUD, crypto, MCP server, security boundaries, encryption roundtrip/tamper/domain isolation, audit log, ULID/FTS/pruning.

## Business Model

Open-source protocol (Apache 2.0). Enterprise SaaS ledger hosting. **Stripe for AI Memory.**

## License

Apache 2.0
