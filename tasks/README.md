# USRCP Task Briefs

Each numbered file in this directory is a self-contained brief for a single piece of work, written so it can be handed to a fresh Claude Code session as a one-shot prompt. Most of the early tasks have shipped; the briefs stay here as the record of what was specified and why.

A note on framing: the earliest briefs (especially task 00) were written when the project pitched itself as "cross-channel memory" — continuity of conversation across chat platforms. That framing predates the search-story decision in [`strategy/SEARCH_DECISION.md`](../strategy/SEARCH_DECISION.md), which deliberately repositioned USRCP as **cross-platform structured state** (Path B), not conversational recall. Read the older briefs with that in mind.

## Demo (canonical)

- [`32-demo-script.md`](32-demo-script.md) — Recording-ready demo script: cross-editor structured state, verified end-to-end on a clean tmp HOME. **This is the canonical demo.**

## Original v0.x batch (00–08)

- [`00-discord-end-to-end-demo.md`](00-discord-end-to-end-demo.md) — Discord capture+reader adapter as an end-to-end "cross-channel memory vision" proof. Historical: written before the Path B decision; shipped as `usrcp-discord`, now positioned as an experimental conversation-capture adapter. The canonical demo is [`32-demo-script.md`](32-demo-script.md).
- [`01-npx-installer.md`](01-npx-installer.md) — One-line install via `npx usrcp init`.
- [`02-schemaless-extensions.md`](02-schemaless-extensions.md) — Schemaless `extensions` table for free-form encrypted facts.
- [`03-search-decision.md`](03-search-decision.md) — Decide search story: semantic embeddings vs structured-memory framing. Resolved as Path B in [`strategy/SEARCH_DECISION.md`](../strategy/SEARCH_DECISION.md).
- [`04-conflict-semantics.md`](04-conflict-semantics.md) — Conflict resolution semantics for concurrent writers (optimistic locking).
- [`05-authenticated-transport.md`](05-authenticated-transport.md) — Authenticated MCP transport.
- [`06-hosted-ledger-mvp.md`](06-hosted-ledger-mvp.md) — Hosted ledger MVP for multi-device sync (ciphertext-only).
- [`07-external-integration.md`](07-external-integration.md) — Land the first external (non-Claude-Code) agent integration.
- [`08-multi-user-local.md`](08-multi-user-local.md) — Multi-user identity resolution in local mode.

## Release & verification

- [`09-verify-and-commit.md`](09-verify-and-commit.md) — Verify the v0.2 work and commit it cleanly.

## usrcp-stream

- [`10-usrcp-stream.md`](10-usrcp-stream.md) — Build `usrcp-stream`, a sibling package for the cross-surface conversation layer (kept outside the core protocol, consistent with the structured-state positioning).
- [`usrcp-stream-codex-review.md`](usrcp-stream-codex-review.md) — Codex review of `feat/usrcp-stream` (commit 99af162).
- [`usrcp-stream-codex-review-round-2.md`](usrcp-stream-codex-review-round-2.md) — Codex review round 2 (commit 439f2d9).
- [`usrcp-stream-codex-review-round-3.md`](usrcp-stream-codex-review-round-3.md) — Codex review round 3 (commit 6496392).
- [`usrcp-stream-codex-review-pr-42.md`](usrcp-stream-codex-review-pr-42.md) — Codex review of PR #42 phase 6 (commit 08466b1).

## Multi-device pairing & identity

- [`11-multi-device-pairing.md`](11-multi-device-pairing.md) — Multi-device identity pairing flow.
- [`12-pair-tier-2.md`](12-pair-tier-2.md) — Pairing v2 with an out-of-band secret.
- [`13-identity-rotation.md`](13-identity-rotation.md) — Identity rotation / revocation.
- [`15-pair-qr.md`](15-pair-qr.md) — QR-code output for `usrcp pair init`.
- [`30-pair-join-atomic.md`](30-pair-join-atomic.md) — `pairJoin` atomic-write fix (Codex Tier-1 #2).

## Cloud

- [`14-cloud-hardening.md`](14-cloud-hardening.md) — Cloud hardening: rate limiting + probe detection.

## Adapters

- [`16-google-calendar-adapter.md`](16-google-calendar-adapter.md) — Google Calendar capture adapter.
- [`17-gmail-adapter.md`](17-gmail-adapter.md) — Gmail capture adapter.
- [`18-google-oauth-localhost.md`](18-google-oauth-localhost.md) — Localhost OAuth flow for the Google adapters.
- [`22-usrcp-github-adapter.md`](22-usrcp-github-adapter.md) — `usrcp-github` adapter (v1: PRs you opened).
- [`23-github-pr-state-changes.md`](23-github-pr-state-changes.md) — `usrcp-github` v1.1: PR state changes.
- [`24-github-issues-and-comments.md`](24-github-issues-and-comments.md) — `usrcp-github` v1.2: issues + issue comments.
- [`25-github-pr-reviews.md`](25-github-pr-reviews.md) — `usrcp-github` v1.3: PR reviews on others' PRs.
- [`27-adapter-marketplace-scaffolding.md`](27-adapter-marketplace-scaffolding.md) — Adapter marketplace scaffolding.
- [`29-github-content-audit.md`](29-github-content-audit.md) — GitHub adapter content-filter audit.

## Secrets & key rotation

- [`19-adapter-encrypted-secrets.md`](19-adapter-encrypted-secrets.md) — Encrypt adapter secrets at rest.
- [`20-chat-adapter-encrypted-secrets.md`](20-chat-adapter-encrypted-secrets.md) — Encrypt Discord / Slack / Telegram secrets at rest.
- [`21-rotate-reencrypts-adapter-configs.md`](21-rotate-reencrypts-adapter-configs.md) — Re-encrypt adapter configs during `usrcp_rotate_key`.
- [`31-rotate-adapter-checkpoint.md`](31-rotate-adapter-checkpoint.md) — Rotate-key adapter-config crash-resume checkpoint (Codex Tier-1 #3).

## Scope enforcement

- [`26-mcp-scope-hardening.md`](26-mcp-scope-hardening.md) — MCP scope hardening: asymmetric read/write permissions.
- [`28-shared-scope-enforcement.md`](28-shared-scope-enforcement.md) — Lift the scope-enforcement wrapper into a shared module.

## Usage

To hand any task to Claude Code, from the repo root:

```
claude < tasks/01-npx-installer.md
```

Or paste the file body into a fresh session.
