# USRCP — User Context Protocol

**The missing standard for human-to-AI memory.**

AI has an amnesia problem. The industry solved model routing (MCP) and agent routing (ACP), but the **human layer** — preferences, history, identity — is entirely fragmented. Every session starts from zero. Every platform rebuilds context from scratch.

USRCP is a standardized, platform-agnostic protocol for AI systems to **query**, **append**, and **synchronize** a specific human's state across disparate systems via a lightweight handshake to a **User State Ledger**.

## Protocol Stack Position

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

## Core Operations

| Operation | URI | Description |
|-----------|-----|-------------|
| **Get State** | `usrcp://get_state` | Query user identity, preferences, and recent timeline |
| **Append Event** | `usrcp://append_event` | Write a new interaction event to the user's ledger |
| **Sync** | `usrcp://sync` | Bi-directional state reconciliation between platforms |

## Architecture

- **User State Ledger** — Append-only log of user interactions, preferences, and context across all connected platforms
- **Scoped Context Keys** — Cryptographic access control so a coding agent can't read therapy bot logs
- **Sub-50ms Handshake** — Edge-cached state with HMAC-signed bearer tokens; no round-trip bottleneck on LLM generation

## Project Structure

```
usrcp/
├── spec/                  # Protocol specification
│   └── PROTOCOL.md        # Full technical spec
├── schemas/               # JSON schemas
│   ├── get_state.json     # usrcp://get_state payload
│   ├── append_event.json  # usrcp://append_event payload
│   └── handshake.json     # Auth handshake schema
├── packages/
│   └── usrcp-local/           # Local MCP server (the wedge)
│       ├── src/
│       │   ├── index.ts       # CLI entry point (init/serve/status)
│       │   ├── server.ts      # MCP server with 8 tools
│       │   ├── ledger.ts      # SQLite ledger operations
│       │   ├── crypto.ts      # Ed25519 keys & domain key derivation
│       │   ├── types.ts       # TypeScript types
│       │   └── __tests__/     # Vitest test suite (58 tests)
│       └── package.json
├── strategy/
│   ├── GTM.md                 # Go-to-market strategy
│   └── PITCH.md               # Investor executive summary
└── docs/
    └── SECURITY.md            # Security & privacy model
```

## Quickstart

```bash
cd packages/usrcp-local
npm install && npm run build
node dist/index.js init
```

This creates `~/.usrcp/` with a SQLite ledger and Ed25519 keys, and registers as an MCP server in Claude Code. Every agent session now has persistent memory.

## Business Model

Open-source protocol. Enterprise SaaS ledger hosting. **Stripe for AI Memory.**

## Status

🟡 **Pre-release** — Local MCP server functional. 58 tests passing.

## License

Apache 2.0
