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
├── sdk/
│   ├── typescript/        # TypeScript SDK
│   └── python/            # Python SDK
├── strategy/
│   ├── GTM.md             # Go-to-market strategy
│   └── PITCH.md           # Investor executive summary
└── docs/
    └── SECURITY.md        # Security & privacy model
```

## Business Model

Open-source protocol. Enterprise SaaS ledger hosting. **Stripe for AI Memory.**

## Status

🟡 **Pre-release** — Specification draft in progress.

## License

Apache 2.0
