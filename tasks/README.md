# USRCP Task Briefs

Each file in this directory is a self-contained brief for a single piece of work, written so it can be handed to a fresh Claude Code session as a one-shot prompt. Tasks are ordered by impact-per-effort.

## Quick wins (low effort, high leverage)

1. [`01-npx-installer.md`](01-npx-installer.md) — One-line install via `npx usrcp init`
2. [`02-schemaless-extensions.md`](02-schemaless-extensions.md) — Free-form encrypted facts table
3. [`03-search-decision.md`](03-search-decision.md) — Decide: semantic embeddings vs structured-memory framing
4. [`04-conflict-semantics.md`](04-conflict-semantics.md) — Concurrency model + optimistic locking

## Strategic bets (multi-week)

5. [`05-authenticated-transport.md`](05-authenticated-transport.md) — TLS + bearer auth for MCP transport
6. [`06-hosted-ledger-mvp.md`](06-hosted-ledger-mvp.md) — Cross-device sync via hosted ciphertext-only ledger
7. [`07-external-integration.md`](07-external-integration.md) — Land first non-Claude-Code agent (Cursor preferred)

## Edge case (defer until non-developer users)

8. [`08-multi-user-local.md`](08-multi-user-local.md) — Multiple users per machine

## Usage

To hand any task to Claude Code:

```
cd /Users/frankbot/usrcp
claude < tasks/01-npx-installer.md
```

Or paste the file body into a fresh session.
