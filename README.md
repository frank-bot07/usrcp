# USRCP — User Context Protocol

**Structured user state that follows you across AI tools. Local-first. Open source. AES-256-GCM encrypted, and you hold the key.**

You told Claude Desktop your stack on Tuesday. On Wednesday, Cursor doesn't know. Thursday, Codex asks again. Every AI tool you use has its own memory, or none.

USRCP is a local, encrypted SQLite ledger that any MCP-aware tool can read and write. One install, one passphrase, and every tool shares the same structured user state — your timezone, your stack, your projects, your preferences.

Registers with **Claude Desktop**, **Cursor**, **Continue**, **Cline**, and terminal agents (**Claude Code**, **Codex CLI**, **Copilot CLI**, **Aider**, **OpenCode**, **Antigravity**). Captures structured activity from **GitHub**, **Linear**, **Obsidian**, **Claude Code sessions**, and **Google Calendar** — plus an [experimental conversation-capture set](#conversation-capture-adapters-experimental).

```bash
brew install frank-bot07/usrcp/usrcp
usrcp init
```

<!-- TODO(chad): swap the demo link below for the 30s screencast once recorded — runbook in tasks/32-demo-script.md -->
→ **See it work:** [the cross-editor demo](docs/demos/cross-editor.md), or prove the claim on your own machine in one command — `node scripts/cross-client-proof.mjs` (writes state as one editor, reads it as another, then scans the raw DB to show it's all ciphertext).
→ Apache 2.0 · 600+ tests · threat model in [`docs/SECURITY.md`](docs/SECURITY.md)

---

> **What USRCP is not.** USRCP is **not** a semantic memory layer. It doesn't do vector search, embeddings, or fuzzy conversational recall. If you ask "what did I tell you about my anxiety meds last week?" USRCP won't find that unless you stored it as a structured fact. For fuzzy recall over chat transcripts, use [Mem0](https://mem0.ai) or [Zep](https://www.getzep.com) — they solve a different problem. See [What USRCP is vs. isn't](#what-usrcp-is-vs-isnt) below.

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
| **Does the server see plaintext?** | No — content is never sent in the clear; identifiers are opaque ([relay metadata caveats](docs/SECURITY.md#9-cloud-sync-relay--what-the-operator-sees)). | Yes — at embed time. |
| **Cross-device sync**        | Content zero-knowledge (relay holds opaque payload ciphertext) — platform names, timing, pseudonym counts visible to relay; see [`docs/SECURITY.md` §9](docs/SECURITY.md#9-cloud-sync-relay--what-the-operator-sees) | Provider-trusted                |
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

### vs OpenMemory MCP (Mem0)

Mem0 shipped [OpenMemory MCP](https://mem0.ai/blog/introducing-openmemory-mcp) in early 2026 — a local-first MCP server that shares memory across Cursor / Claude / Windsurf / Cline. Closest neighbor on positioning. The differentiation is real but tight:

|                              | USRCP                                                            | OpenMemory MCP                                  |
| ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| **Memory shape**             | Structured user state (identity, prefs, projects, timeline) + blind-index search over ciphertext | Vector-embedded semantic recall of chat turns   |
| **Install footprint**        | One SQLite file, `brew install`                                  | Docker (frontend + MCP server + vector DB)      |
| **External API dependency**  | None — works offline                                             | Requires an OpenAI API key (memory extraction is an LLM call) |
| **Encryption at rest**       | AES-256-GCM; user owns the key; relay sees only content ciphertext ([metadata caveats](docs/SECURITY.md#9-cloud-sync-relay--what-the-operator-sees)) | Not a claim |
| **Cross-vendor sync**        | Optional content-zero-knowledge relay (`usrcp-stream`)           | Not addressed                                   |
| **License**                  | Apache 2.0                                                       | OSS                                             |

Same broad goal (cross-tool memory you control); different shape of "memory" and a much smaller install footprint here. Worth using both if your workflow wants structured state *and* semantic chat recall.

### vs vendor-built memory (Claude Memory, ChatGPT Memory, Cursor Memory)

The 2026 vendor surfaces — Claude Memory, ChatGPT Memory, Gemini personalization — solve the cross-session problem **within** one vendor. USRCP solves it **across** vendors. If you only use Claude (or only ChatGPT), the vendor's built-in memory is probably enough. The day you add a second tool, USRCP starts paying for itself: the structured user state you typed once is there in every MCP-aware client, and the encryption key stays with you instead of the vendor.

Cursor users specifically: native `@memories` was removed in v2.1.x. USRCP is one way to fill that gap that also bonus-shares the memory with the rest of your stack.

## Quickstart

### Install

**npm (recommended)** — the `usrcp` CLI + encrypted ledger:

```bash
npm install -g usrcp        # the `usrcp` command + local ledger
# …or run without installing:
npx usrcp init
```

This ships the core CLI with the inline adapters (`terminal`, `mcp-agent`, `openclaw`). Capture adapters install as their own packages, then you configure each with the setup wizard:

```bash
# structured-state adapters:
npm install -g usrcp-github   # or usrcp-linear, usrcp-obsidian, usrcp-claude-code, usrcp-google-calendar
usrcp setup --adapter=github

# experimental conversation-capture set:
npm install -g usrcp-slack    # or usrcp-discord, usrcp-telegram, usrcp-imessage, usrcp-gmail
usrcp setup --adapter=slack
```

See the [Adapters](#capture-adapters) table for the full list (the Chrome extension and VS Code viewer ship separately — see their package READMEs).

**Homebrew (macOS / Linux)** — alternative for the core CLI:

```bash
brew install frank-bot07/usrcp/usrcp
```

**From source** — for contributing or running unreleased changes:

```bash
git clone https://github.com/frank-bot07/usrcp.git
# Build the protocol core first — usrcp-local's build compiles it.
cd usrcp/packages/usrcp-core && npm install && npm run build
cd ../usrcp-local && npm install && npm run build && npm link
```

### First run

```bash
# Interactive init — prompts for passphrase by default
usrcp init

# Non-interactive:
usrcp init --passphrase "your secret phrase"       # passphrase mode
usrcp init --dev                                     # dev mode (key on disk)

# Start the server
usrcp serve
```

In passphrase mode, `init` offers to store the passphrase in the **OS keychain** (macOS Keychain / Linux Secret Service); pass `--keychain` / `--no-keychain` to decide non-interactively. With a keychain entry present, MCP clients auto-start the server with no plaintext passphrase in any config file. Manage the entry anytime:

```bash
usrcp keychain store    # add/replace (verifies the passphrase unlocks this ledger first)
usrcp keychain status   # show backend + whether an entry exists
usrcp keychain clear    # remove it

# Prefer no keychain? The env var path still works:
USRCP_PASSPHRASE="your secret phrase" usrcp serve
```

`init` creates `~/.usrcp/users/<slug>/` with an encrypted SQLite ledger and writes the MCP server entry to Claude Desktop's config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Single-user is the default and what every shared-machine consideration in the rest of this README assumes. If two people use the same OS account (or you run multiple identities side by side), see [Multiple users on one machine](#multiple-users-on-one-machine) below — each user gets an independent ledger and passphrase under a `--user=<name>` slug.

### Adding capture adapters

Adapters watch a source (a GitHub org, an Obsidian vault, a Linear workspace, etc.) and append the activity you authored into the same ledger your local MCP server reads from. Install the adapter's package, then run the setup wizard to configure it:

```bash
npm install -g usrcp-linear          # install the adapter you want
usrcp setup --adapter=linear         # configure it (validates credentials, picks scope)
# or, to browse what's installed:
usrcp setup                          # interactive picker
```

See the [Adapters](#capture-adapters) tables below for the full list.

### Multiple users on one machine

```bash
usrcp init --user=frank
usrcp init --user=jess
usrcp serve --user=frank   # or rely on --user in the registered MCP entry
usrcp users                # list available slugs
```

Each user gets an independent ledger, passphrase, and MCP server entry.

### Passphrase mode and terminal agents

If you initialized USRCP in passphrase mode (`usrcp init` with the default), the MCP server needs the passphrase to decrypt the ledger. The terminal-adapter `register()` writes only `command + args` to each agent's config — it never bakes the passphrase in.

**Recommended: the OS keychain.** One command covers every agent — shell-launched and GUI alike — with nothing in plaintext on disk:

```sh
usrcp keychain store
```

The server checks `USRCP_PASSPHRASE`, then `--passphrase`, then the keychain, so existing setups keep working unchanged. (Windows: keychain support isn't wired up yet — use the env-var paths below.)

**Env-var alternatives**, if you'd rather not use the keychain:

- **Shell-launched agents** (`claude-code`, `codex`, `copilot-cli`, `aider`, `opencode`) — add to `~/.zshrc` / `~/.bashrc` and restart your shell:

  ```sh
  export USRCP_PASSPHRASE="your secret phrase"
  ```

- **GUI/IDE-launched agents** (`cursor`, `cline`, `continue`, `antigravity`) do **not** inherit shell environment. Either add an `env` block under the `usrcp` server entry in the agent's config file (JSON for Cursor/Cline/Continue, TOML for Codex), or set a system-wide GUI env on macOS with `launchctl setenv USRCP_PASSPHRASE "..."` (persists until reboot; use a `~/Library/LaunchAgents/` plist for permanence).

**Treat any config file you bake the passphrase into as a secret** — it sits in plaintext on disk and is the weakest link in an otherwise-encrypted setup. This is exactly what `usrcp keychain store` exists to avoid.

The wizard prints this same guidance after registration, so you can also re-run `usrcp setup` or `usrcp adapter add terminal --targets=<list>` for a reminder.

## Capture Adapters

Adapters are independent processes that read from a source and append events to the local ledger via the same encrypted-at-rest pipeline as the MCP server. Each adapter handles its own auth, idempotency, and cursor persistence.

### Structured-state adapters

These are the headline adapters: they capture genuinely structured dev/work state — issues, PRs, notes, calendar events, coding-session context — the kind of data USRCP's schema and exact-keyword search are built for.

| Adapter | What it captures | Mode | Requirements |
|---------|------------------|------|--------------|
| [`usrcp-github`](packages/usrcp-github) | PRs you opened / merged / closed, issues you opened, comments + reviews you authored, in optional org allowlist | Capture-only (v0) | GitHub personal access token (`repo` + `read:user` scopes) |
| [`usrcp-linear`](packages/usrcp-linear) | Issues + comments you author in Linear | Capture-only (v0) | Linear personal API key |
| [`usrcp-obsidian`](packages/usrcp-obsidian) | Notes you create or edit in an Obsidian vault | Capture-only (v0) | A local vault directory |
| [`usrcp-claude-code`](packages/usrcp-claude-code) | User / assistant turns from your Claude Code CLI sessions, tailed from `~/.claude/projects/<cwd>/*.jsonl` | Capture-only (stream) | Claude Code CLI installed; `allowlisted_projects` in `~/.usrcp/claude-code-config.json` |
| [`usrcp-google-calendar`](packages/usrcp-google-calendar) | Timed events on your primary calendar that have already ended | Capture-only (v0) | Google Cloud OAuth client + Calendar API enabled |

Alongside these, the inline adapters that ship with the brew CLI (`terminal`, `mcp-agent`, `openclaw`) wire the same structured state into terminal agents and agent harnesses — see [Editor & CLI Integrations](#editor--cli-integrations) and [Agent harness integrations](#agent-harness-integrations). The [VS Code viewer](#ledger-viewers) browses the resulting ledger read-only.

### Conversation capture adapters (experimental)

These adapters capture messages you send — in iMessage, Slack, Discord, Telegram, Gmail, or on claude.ai — into the encrypted ledger. Be clear-eyed about the trade: search over captured messages is exact-keyword only, with no semantic recall, which is the weakest retrieval model for free-form chat (see [What USRCP is vs. isn't](#what-usrcp-is-vs-isnt)). If conversational memory is your primary need, Mem0 or Zep are better tools for that job. These adapters exist for users who want specific structured facts pulled from their conversations to live under their own key, not for fuzzy recall over chat history.

| Adapter | What it captures | Mode | Requirements |
|---------|------------------|------|--------------|
| [`usrcp-imessage`](packages/usrcp-imessage) | Messages you sent in Apple iMessage | Capture + reader | **macOS only.** Full Disk Access for Messages.app; `brew install steipete/tap/imsg` |
| [`usrcp-slack`](packages/usrcp-slack) | Messages you sent in Slack; `@usrcp` queries from chat | Capture + reader + bot | **Paid Slack tier** (Pro/Business+/Enterprise) — bot APIs are restricted on free; Anthropic API key for `@usrcp` replies |
| [`usrcp-discord`](packages/usrcp-discord) | Messages you sent in Discord; `@usrcp` queries from chat | Capture + reader + bot | A Discord server you control; Anthropic API key for `@usrcp` replies |
| [`usrcp-telegram`](packages/usrcp-telegram) | Messages you sent in Telegram; `@usrcp` queries from chat | Capture + reader + bot | A Telegram bot token (BotFather); Anthropic API key for `@usrcp` replies |
| [`usrcp-gmail`](packages/usrcp-gmail) | Messages you sent in Gmail (subject, body, recipients, labels) | Capture-only (v0) | Google Cloud OAuth client + Gmail API enabled |
| [`usrcp-extension`](packages/usrcp-extension) | Conversations on claude.ai; `/usrcp` slash-command for ledger lookup | Capture + injector | **Chrome only.** Manual unpacked load (Developer Mode → Load Unpacked) |

Install an adapter's package (`npm install -g usrcp-<value>`), then configure it with `usrcp setup --adapter=<value>` (e.g. `npm i -g usrcp-linear && usrcp setup --adapter=linear`). Run `usrcp setup` alone for an interactive picker over the adapters you've installed.

All adapters write under a configurable `domain` (default matches the source name) and use stable, source-side IDs as idempotency keys, so re-polling or re-watching the same window cannot double-write. Capture-only adapters do not reply; bot adapters reply only to explicit `@usrcp` / `/usrcp` mentions and answer using the same ledger the user sees.

### Agent harness integrations

These adapters expose USRCP's tools to a third-party AI agent harness. They don't capture new events on their own — capture from external surfaces (Discord, Slack, iMessage, etc.) still goes through the dedicated capture adapters above. Install the harness first, then run the USRCP setup route.

| Integration | Purpose | Mode | Requirements |
|-------------|---------|------|--------------|
| [`usrcp-hermes`](packages/usrcp-hermes) | Memory-provider plugin for [Hermes Agent](https://github.com/hermesagent/hermes-agent). Adds USRCP as a 9th external memory provider; system-prompt context, prefetch, sync_turn capture. | Bidirectional plugin | Hermes installed; `usrcp` CLI on PATH; `mcp` Python package |
| `openclaw` | Registers `usrcp serve` as an MCP server in your [OpenClaw](https://docs.openclaw.ai) config. OpenClaw agents get all 12 USRCP tools via the same path Claude Code uses. | Read-side (MCP server) | **OpenClaw already installed** — install first at https://docs.openclaw.ai/start/getting-started, then `usrcp setup --adapter=openclaw` |

### Ledger viewers

Read-only clients that browse the encrypted ledger via a local `usrcp serve` subprocess. No network calls; the viewer never sees plaintext outside the host process.

| Viewer | Surface | Mode | Requirements |
|--------|---------|------|--------------|
| [`usrcp-vscode`](packages/usrcp-vscode) | VS Code activity-bar **USRCP** view — Facts tree by domain, status indicator, "Open Ledger Directory" command. | Read-only client | VS Code; `usrcp` CLI on PATH (or set `usrcp.binaryPath`) |

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

**All your content.** Every field that carries what you said, did, or stored is
ciphertext at rest. What stays in the clear is structural metadata — opaque
identifiers and timestamps that reveal *when*, never *what*. An attacker reading
the SQLite file sees:

| Column | What they see |
|--------|--------------|
| `event_id` | Opaque ULID (plaintext — random identifier, no content) |
| `timestamp` | When, not what (plaintext) |
| `domain` | HMAC pseudonym (`d_1ac6397ab4d2`) |
| `summary` | `enc:base64ciphertext...` |
| `intent` | `enc:base64ciphertext...` |
| `outcome` | `enc:base64ciphertext...` |
| `platform` | `enc:base64ciphertext...` |
| `detail` | `enc:base64ciphertext...` |
| `tags` | `enc:base64ciphertext...` |
| `audit_log.*` | `enc:base64ciphertext...` |

The same rule holds in the other tables: in `active_projects`, the content
fields (`name`, `domain`, `status`, `summary`) are `enc:` ciphertext; the
`project_id` you choose is stored as an HMAC (with the original encrypted in
`project_ref_enc`), and only `last_touched` (a timestamp) stays plaintext. No
field that holds user content is ever stored in the clear.

In passphrase mode, no key file exists on disk. The key is derived via scrypt on startup and zeroed on shutdown.

Each adapter's test suite includes a **ciphertext-at-rest** check: it captures real activity, then opens the SQLite file with raw `better-sqlite3` and asserts no plaintext markers (titles, bodies, URLs, IDs) appear in any encrypted column.

## Security Architecture

- **AES-256-GCM** encryption at rest for all content fields
- **Domain-scoped keys** via HKDF-SHA256 — coding key cannot decrypt health data
- **scrypt** passphrase derivation (N=131072, r=8, p=2) — key never on disk
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
│   ├── usrcp-core/                   # Framework-agnostic protocol core (ledger, crypto, encryption, pairing, rotation, scope)
│   ├── usrcp-local/                  # Local MCP server + CLI
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

The legacy `sdk/` was a pre-protocol exploration — see [`sdk/README.md`](sdk/README.md) for the historical context. New work should target the `usrcp-core` ledger directly.

## Tests

Current snapshot (per-package `npm test`):

| Package | Tests |
|---------|-------|
| `usrcp-local` | 321 |
| `usrcp-core` | 230 |
| `usrcp-stream` | 125 |
| `usrcp-github` | 90 |
| `usrcp-obsidian` | 65 |
| `usrcp-imessage` | 54 |
| `usrcp-telegram` | 53 |
| `usrcp-linear` | 52 |
| `usrcp-slack` | 52 |
| `usrcp-extension` | 46 |
| `usrcp-discord` | 45 |
| `usrcp-gmail` | 41 |
| `usrcp-google-calendar` | 33 |
| `usrcp-adapter-kit` | 32 |
| `usrcp-cloud` | 30 |
| `usrcp-claude-code` | 28 |
| **Total** | **~1297** |

Plus a Python suite in `usrcp-hermes` (`pytest`).

Run a package's suite with `npm test` from inside its directory. Cross-package
`prebuild`/`pretest` hooks build `usrcp-core` (and other siblings) first so types
stay in sync. Coverage spans: ledger CRUD, crypto roundtrips, tamper detection,
domain isolation, audit log, ULID, pruning, multi-user isolation, optimistic
concurrency, schemaless facts, scope enforcement (all in `usrcp-core`); sync
push/pull, Ed25519 signed-request auth (`usrcp-local`/`usrcp-cloud`); and
per-adapter capture/idempotency/ciphertext-at-rest checks.

## Business Model

Open-source protocol (Apache 2.0). The reference implementation is free and local-first. Revenue comes from the hosted ledger — cross-device sync, team ledgers, compliance-grade audit features — all operating on ciphertext only.

The wedge isn't "every AI-using human." It's **security-conscious developers and regulated enterprises** who can't adopt an AI state store that phones a third party with plaintext. See [strategy/PITCH.md](strategy/PITCH.md) and [strategy/GTM.md](strategy/GTM.md) for the full positioning.

## License

Apache 2.0
