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

`init` creates `~/.usrcp/users/<slug>/` with an encrypted SQLite ledger and writes the MCP server entry to Claude Desktop's config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Adding capture adapters

Adapters watch a source (a Slack workspace, an Obsidian vault, your iMessage chat.db, etc.) and append the activity you authored into the same ledger your local MCP server reads from. One wizard installs and configures any adapter:

```bash
usrcp setup                          # interactive picker
usrcp setup --adapter=linear         # straight to one adapter
```

See the [Adapters](#capture-adapters) table below for the full list.

### Multiple users on one machine

```bash
usrcp init --user=frank
usrcp init --user=jess
usrcp serve --user=frank   # or rely on --user in the registered MCP entry
usrcp users                # list available slugs
```

Each user gets an independent ledger, passphrase, and MCP server entry.

### Passphrase mode and terminal agents

If you initialized USRCP in passphrase mode (`usrcp init` with the default), the MCP server requires `USRCP_PASSPHRASE` in its environment to decrypt the ledger. The terminal-adapter `register()` writes only `command + args` to each agent's config — it never bakes the passphrase in. You have to provide it yourself, and *how* depends on whether the agent is launched from a shell or from a GUI app.

**Shell-launched agents** — `claude-code`, `codex`, `copilot-cli`, `aider`, `opencode`. Add this to `~/.zshrc` or `~/.bashrc` and restart your shell:

```sh
export USRCP_PASSPHRASE="your secret phrase"
```

**GUI/IDE-launched agents** — `cursor`, `cline` (VS Code), `continue`, `antigravity`. These do **not** inherit shell environment. Two options:

1. **Per-agent env block.** Edit the agent's config file and add an `env` block under the `usrcp` server entry:

   ```jsonc
   // ~/.cursor/mcp.json (and similar JSON configs)
   "mcpServers": {
     "usrcp": {
       "command": "/opt/homebrew/bin/usrcp",
       "args": ["serve", "--stdio"],
       "env": { "USRCP_PASSPHRASE": "your secret phrase" }
     }
   }
   ```

   For Codex (TOML), the equivalent is:

   ```toml
   [mcp_servers.usrcp]
   command = "/opt/homebrew/bin/usrcp"
   args = ["serve", "--stdio"]
   env = { USRCP_PASSPHRASE = "your secret phrase" }
   ```

2. **System-wide env (macOS).** Sets the variable for all GUI apps until reboot:

   ```sh
   launchctl setenv USRCP_PASSPHRASE "your secret phrase"
   ```

   For persistence across reboots, install a `LaunchAgent` plist under `~/Library/LaunchAgents/`.

**Treat any config file you bake the passphrase into as a secret** — it sits in plaintext on disk. The system-wide `launchctl` path keeps the passphrase out of static files.

The wizard prints this same guidance after registration, so you can also re-run `usrcp setup` or `usrcp adapter add terminal --targets=<list>` for a reminder.

## Capture Adapters

Adapters are independent processes that read from a source and append events to the local ledger via the same encrypted-at-rest pipeline as the MCP server. Each adapter handles its own auth, idempotency, and cursor persistence.

| Adapter | What it captures | Mode | Requirements |
|---------|------------------|------|--------------|
| [`usrcp-imessage`](packages/usrcp-imessage) | Messages you sent in Apple iMessage | Capture + reader | **macOS only.** Full Disk Access for Messages.app; `brew install steipete/tap/imsg` |
| [`usrcp-slack`](packages/usrcp-slack) | Messages you sent in Slack; `@usrcp` queries from chat | Capture + reader + bot | **Paid Slack tier** (Pro/Business+/Enterprise) — bot APIs are restricted on free; Anthropic API key for `@usrcp` replies |
| [`usrcp-discord`](packages/usrcp-discord) | Messages you sent in Discord; `@usrcp` queries from chat | Capture + reader + bot | A Discord server you control; Anthropic API key for `@usrcp` replies |
| [`usrcp-telegram`](packages/usrcp-telegram) | Messages you sent in Telegram; `@usrcp` queries from chat | Capture + reader + bot | A Telegram bot token (BotFather); Anthropic API key for `@usrcp` replies |
| [`usrcp-obsidian`](packages/usrcp-obsidian) | Notes you create or edit in an Obsidian vault | Capture-only (v0) | A local vault directory |
| [`usrcp-linear`](packages/usrcp-linear) | Issues + comments you author in Linear | Capture-only (v0) | Linear personal API key |
| [`usrcp-extension`](packages/usrcp-extension) | Conversations on claude.ai; `/usrcp` slash-command for ledger lookup | Capture + injector | **Chrome only.** Manual unpacked load (Developer Mode → Load Unpacked) |

Install any adapter via `usrcp setup --adapter=<value>` (e.g. `usrcp setup --adapter=linear`), or run `usrcp setup` for an interactive picker.

All adapters write under a configurable `domain` (default matches the source name) and use stable, source-side IDs as idempotency keys, so re-polling or re-watching the same window cannot double-write. Capture-only adapters do not reply; bot adapters reply only to explicit `@usrcp` / `/usrcp` mentions and answer using the same ledger the user sees.

### Agent harness integrations

These adapters expose USRCP's tools to a third-party AI agent harness. They don't capture new events on their own — capture from external surfaces (Discord, Slack, iMessage, etc.) still goes through the dedicated capture adapters above. Install the harness first, then run the USRCP setup route.

| Integration | Purpose | Mode | Requirements |
|-------------|---------|------|--------------|
| [`usrcp-hermes`](packages/usrcp-hermes) | Memory-provider plugin for [Hermes Agent](https://github.com/hermesagent/hermes-agent). Adds USRCP as a 9th external memory provider; system-prompt context, prefetch, sync_turn capture. | Bidirectional plugin | Hermes installed; `usrcp` CLI on PATH; `mcp` Python package |
| `openclaw` | Registers `usrcp serve` as an MCP server in your [OpenClaw](https://docs.openclaw.ai) config. OpenClaw agents get all 12 USRCP tools via the same path Claude Code uses. | Read-side (MCP server) | **OpenClaw already installed** — install first at https://docs.openclaw.ai/start/getting-started, then `usrcp setup --adapter=openclaw` |

### Cross-device sync

[`usrcp-cloud`](packages/usrcp-cloud) is the hosted ledger for syncing the local SQLite store across devices. It only ever sees ciphertext — encryption happens client-side under the user's passphrase before push, and decryption happens client-side after pull. The server cannot read your data.

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
| `usrcp_status` | Ledger stats and health (scope-aware: scoped agents see only their domains) |

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

Each adapter's test suite includes a **ciphertext-at-rest** check: it captures real activity, then opens the SQLite file with raw `better-sqlite3` and asserts no plaintext markers (titles, bodies, URLs, IDs) appear in any encrypted column.

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
- **Scope enforcement** — agents registered with a `--scope` flag see only the domains they're authorized for; `usrcp_status` and timeline queries filter accordingly

Full model in [docs/SECURITY.md](docs/SECURITY.md).

## Editor & CLI Integrations

USRCP works with any MCP-compatible client. The `usrcp init` wizard registers the server entry for editor clients:

| Editor | `--client=` value | Setup doc |
|--------|-------------------|-----------|
| Claude Desktop | `claude` (default) | This README |
| Cursor | `cursor` | [docs/INTEGRATIONS/cursor.md](docs/INTEGRATIONS/cursor.md) |
| Continue.dev | `continue` | [docs/INTEGRATIONS/continue.md](docs/INTEGRATIONS/continue.md) |
| Cline (VS Code) | `cline` | [docs/INTEGRATIONS/cline.md](docs/INTEGRATIONS/cline.md) |

Register with multiple clients at once: `usrcp init --client=claude,cursor` or `--client=all`.

For terminal-based MCP-aware CLI agents (Claude Code, Cursor CLI, Codex, Copilot CLI, Cline, Continue, Aider, Antigravity, OpenCode), a single wizard wires them all up:

```bash
usrcp setup --adapter=terminal
```

No external accounts or bot tokens required — every terminal session in those agents gets cross-platform memory through the same local ledger.

All clients share the same local ledger per user.

## Other Consumers

- [`usrcp-hermes`](packages/usrcp-hermes) — Python memory-provider plugin for [Hermes Agent](https://github.com/hermesagent/hermes-agent). Adds USRCP as a memory backend so Hermes runs share state with Claude Code, Cursor, etc. Thin wrapper — ledger logic stays in TypeScript.

## Project Structure

```
usrcp/
├── spec/
│   └── PROTOCOL.md                  # Protocol specification
├── schemas/                          # JSON schemas (get_state, append_event, handshake)
├── docs/
│   ├── SECURITY.md                   # Security & privacy model
│   └── INTEGRATIONS/                 # MCP client integration guides
├── strategy/                         # GTM, pitch, positioning
├── packages/
│   ├── usrcp-local/                  # Local MCP server + encrypted ledger
│   ├── usrcp-cloud/                  # Hosted ledger for ciphertext-only sync
│   ├── usrcp-discord/                # Discord capture+reader adapter
│   ├── usrcp-extension/              # Chrome extension (claude.ai capture)
│   ├── usrcp-hermes/                 # Hermes Agent memory plugin (Python)
│   ├── usrcp-imessage/               # iMessage capture+reader (macOS)
│   ├── usrcp-linear/                 # Linear issues + comments capture
│   ├── usrcp-obsidian/               # Obsidian vault capture
│   ├── usrcp-slack/                  # Slack capture+reader
│   └── usrcp-telegram/               # Telegram capture+reader
└── sdk/                              # Legacy prototype (Jan-Feb 2026); not the reference impl
```

The legacy `sdk/` was a pre-protocol exploration — see [`sdk/README.md`](sdk/README.md) for the historical context. New work should target the `usrcp-local` ledger directly.

## Tests

| Package | Tests |
|---------|-------|
| `usrcp-local` | 338 |
| `usrcp-obsidian` | 65 |
| `usrcp-imessage` | 39 |
| `usrcp-linear` | 38 |
| `usrcp-cloud` | 30 |
| `usrcp-extension` | 24 |
| `usrcp-telegram` | 22 |
| `usrcp-slack` | 20 |
| `usrcp-discord` | 14 |
| **Total** | **590** |

Plus a Python suite in `usrcp-hermes` (`pytest`).

Run a package's suite with `npm test` from inside its directory. Each adapter's `pretest` hook rebuilds `usrcp-local` first so cross-package types stay in sync. Coverage spans: ledger CRUD, crypto roundtrips, tamper detection, domain isolation, audit log, ULID, pruning, multi-user isolation, optimistic concurrency, schemaless facts, scope enforcement, sync push/pull, Ed25519 signed-request auth, and per-adapter capture/idempotency/ciphertext-at-rest checks.

## Business Model

Open-source protocol (Apache 2.0). The reference implementation is free and local-first. Revenue comes from the hosted ledger — cross-device sync, team ledgers, compliance-grade audit features — all operating on ciphertext only.

The wedge isn't "every AI-using human." It's **security-conscious developers and regulated enterprises** who can't adopt an AI state store that phones a third party with plaintext. See [strategy/PITCH.md](strategy/PITCH.md) and [strategy/GTM.md](strategy/GTM.md) for the full positioning.

## License

Apache 2.0
