# Task 10 — Build `usrcp-stream` (sibling package: cross-surface conversation layer)

**Status:** in progress on branch `feat/usrcp-stream`
**Build prompt:** `/Users/frankbot/Desktop/For Chad/2026-05-15-usrcp-stream-build-prompt.md`
**Reviewer:** Codex GPT-5.5 (invoked by Chad against the draft PR)

## What this is

A new sibling package `packages/usrcp-stream/` that adds bidirectional capture, local embeddings, cross-surface thread stitching, active-surface presence, and pre-warm broadcast. Reuses USRCP's master key and crypto primitives via a distinct HKDF keyspace.

## Relationship to Path B (task 03)

Task 03 approved Path B for `usrcp-local`: structured + keyword-only, no embeddings in the ledger. `usrcp-stream` is a **sibling** package with its own DB (`stream.db`) and its own HKDF domain (`stream-*`). The Path-B decision still holds at the package level — `usrcp-local` does not gain embeddings. `usrcp-stream` is an opt-in adjacent product. README/spec/security docs for `usrcp-local` are **not** touched in this PR.

## Codebase deltas from the build prompt

The build prompt at `/Users/frankbot/Desktop/For Chad/2026-05-15-usrcp-stream-build-prompt.md` was written against the original architecture. Several details contradict the current code. Where they differ, the codebase wins:

| # | Prompt | Reality | Action taken |
|---|---|---|---|
| 1 | `pnpm` workspace | npm with `"file:../usrcp-local"` deps; CI runs `npm test` per package | Use npm. Add `usrcp-stream` to `.github/workflows/test.yml` matrix. |
| 2 | ESM | `module: "Node16"` with no `"type": "module"` → emits CJS with `.js` import extensions | Copy `usrcp-local/tsconfig.json` verbatim. No `"type"` field in `package.json`. |
| 3 | Import via relative path `../../usrcp-local/src/encryption.js` | Adapters import via package + dist: `usrcp-local/dist/encryption.js` | Use package-name + dist imports. |
| 4 | Schema: `content BLOB NOT NULL` | `encrypt()` returns `"enc:<base64>"` string; existing ledger stores encrypted values as TEXT | Encrypted columns are `TEXT`. `embeddings.vec` stays BLOB (raw float32). |
| 5 | "Never reuse `usrcp-domain-${domain}` HKDF" | `deriveDomainEncryptionKey(masterKey, domain)` is the canonical helper; its salt is `usrcp-domain-${domain}` and `domain` is opaque | Call `deriveDomainEncryptionKey(masterKey, "stream-events")` etc. Distinct keyspace via the `stream-` prefix on the domain arg. No new HKDF primitive. |
| 6 | Lazy import at end of `registerAll()` | `registerAll` is invoked from `createServer`; cleaner tail is in `createServer` after the call returns | Place lazy import in `createServer`, post-`registerAll`. |
| 7 | Master key passed by reference | `masterKey` is `/** @internal */` on `Ledger` (`packages/usrcp-local/src/ledger/core.ts:30`) | Add `public getMasterKey(): Buffer` to `Ledger`. |
| 8 | "Use existing logger" | No shared logger; adapters use `console.error` | `usrcp-stream` matches — `console.error` for CLI. |
| 9 | `stream.db` at `getUserDir()/stream.db` | `getUserDir()` returns `~/.usrcp/users/<slug>/` | Confirmed. Config at `${getUserDir()}/stream-config.toml` (encrypted). |
| 10 | MCP SDK `1.29.0` | Confirmed | Pin to `1.29.0`. |
| 11 | `sqlite-vec` preferred, `sqlite-vss` fallback | Neither in repo; `better-sqlite3@11.10.0` is the binding | Use `sqlite-vec` via `db.loadExtension`. If native build fails at `init`, surface the error rather than silently degrading. |
| 12 | Write contradictions to `tasks/usrcp-stream-build-questions.md` | `tasks/` numbers `00`-`09`; convention is numbered | This file is `tasks/10-usrcp-stream.md`. |

## Scope (this branch)

Confirmed by Chad 2026-05-15: build Phases 0–5 + 7 only. Phase 6 (adapter `--mode` flags + new `claude-desktop`/`cursor`/`vscode` capture adapters) is deferred to a follow-up PR.

## Acceptance criteria

See build prompt §13. Branch is mergeable when those pass and Codex has signed off in writing (a file at `tasks/10-usrcp-stream-codex-review.md`).
