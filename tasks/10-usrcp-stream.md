# Task 10 - Build `usrcp-stream` (sibling package: cross-surface conversation layer)

**Status:** in progress on branch `feat/usrcp-stream`
**Build prompt:** `/Users/frankbot/Desktop/For Chad/2026-05-15-usrcp-stream-build-prompt.md`
**Reviewer:** Codex GPT-5.5 (invoked by Chad against the draft PR)

## What this is

A new sibling package `packages/usrcp-stream/` that adds bidirectional capture, local embeddings, cross-surface thread stitching, active-surface presence, and pre-warm broadcast. Reuses USRCP's master key and crypto primitives via a distinct HKDF keyspace.

## Relationship to Path B (task 03)

Task 03 approved Path B for `usrcp-local`: structured + keyword-only, no embeddings in the ledger. `usrcp-stream` is a **sibling** package with its own DB (`stream.db`) and its own HKDF domain (`stream-*`). The Path-B decision still holds at the package level - `usrcp-local` does not gain embeddings. `usrcp-stream` is an opt-in adjacent product. README/spec/security docs for `usrcp-local` are **not** touched in this PR.

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
| 8 | "Use existing logger" | No shared logger; adapters use `console.error` | `usrcp-stream` matches - `console.error` for CLI. |
| 9 | `stream.db` at `getUserDir()/stream.db` | `getUserDir()` returns `~/.usrcp/users/<slug>/` | Confirmed. Config at `${getUserDir()}/stream-config.toml` (encrypted). |
| 10 | MCP SDK `1.29.0` | Confirmed | Pin to `1.29.0`. |
| 11 | `sqlite-vec` preferred, `sqlite-vss` fallback | Neither in repo; `better-sqlite3@11.10.0` is the binding | Use `sqlite-vec` via `db.loadExtension`. If native build fails at `init`, surface the error rather than silently degrading. |
| 12 | Write contradictions to `tasks/usrcp-stream-build-questions.md` | `tasks/` numbers `00`-`09`; convention is numbered | This file is `tasks/10-usrcp-stream.md`. |

## Scope (this branch)

Confirmed by Chad 2026-05-15: build Phases 0–5 + 7 only. Phase 6 (adapter `--mode` flags + new `claude-desktop`/`cursor`/`vscode` capture adapters) is deferred to a follow-up PR.

## Codex round-1 response

Codex review (`tasks/usrcp-stream-codex-review.md`) returned 3 P0 + 5 P1 + 3 P2 findings. All addressed:

| Finding | Resolution |
|---|---|
| P0-1 scope leak in stream_recall / stream_thread | `registerStreamTools` now injects `allowedScopes` into the multi-domain-read tool factories. Recall passes them as `surfaces: string[]` IN-filter to `vectorSearch`. Thread filters events at SQL level and narrows the returned `surfaces` summary to the intersection. Regression tests in `scope-enforcement.test.ts` seed both surfaces, scope to one, call unfiltered recall/thread, assert no out-of-scope rows leak. |
| P0-2 master-key-stability didn't catch HKDF drift | New `frozen HKDF vectors` describe block in `master-key-stability.test.ts` asserts hex bytes for `deriveGlobalEncryptionKey`, `deriveDomainEncryptionKey(stream-{events,threads,surface,config})`, and `deriveBlindIndexKey(stream-events)`. Any change to HKDF salt or info string flips these. |
| P0-3 false-pass-guard didn't mutate impl | Rewrote `false-pass-guard.test.ts` as a real mutation harness: spawns `vitest` as a subprocess per case after patching one of four load-bearing files (encrypt, captureEvent INSERT, vectorSearch early return, stitch link gate). Restores in try/finally + SIGINT/SIGTERM handler. Sets `fileParallelism: false` in vitest config so concurrent test files don't read mid-mutation source. |
| P1-1 same-channel continuation missing | StitchInput now carries `channel_ref`. Threads gain a `recent_channels` encrypted JSON column. Stitcher checks (a) entity overlap within `entity_window_ms` OR (b) same canonical channel key within `same_channel_window_ms` to set the entity component to 1. Tests in `stitch-same-channel.test.ts` link / refuse-to-link as `same_channel_window_ms` is dialed past the gap. |
| P1-2 topic_centroid stored as raw float32 | `topic_centroid` is now TEXT, encrypted via HKDF domain `stream-threads`. Stitcher encrypts on create, decrypts/merges/re-encrypts on attach. On-disk grep test in `encrypted-centroid.test.ts` confirms the raw float32 bytes do not appear in the SQLite file. |
| P1-3 serve ignores stream-config.toml | New `src/config-io.ts` extracts load/save/embedderFromConfig as sync helpers. `registerStreamTools` uses an `"embedder" in options` check: explicit value or null wins; otherwise it auto-loads from `${userDir}/stream-config.toml`. Tests in `config-aware-serve.test.ts` cover roundtrip, wrong-key throw, vendor-consent gate, and the wired status field. |
| P1-4 entity extraction missing | Ingest takes an optional `entityResolver`. When the caller omits `entity_refs`, the resolver is queried (best-effort). `registerStreamTools` wires `makeLedgerEntityResolver` when a `Ledger` is present. Tests in `entity-resolution.test.ts` backfill from active projects, refuse to override caller-supplied refs, and confirm standalone mode (no ledger) is untouched. |
| P2-1 em dashes | Stripped from all stream sources, README, package.json, the two usrcp-local lines I authored, and this tasks doc. |
| P2-2 vendor-flag claim in README | Reworded: providers can be selected via the interactive menu or `--embedding-provider <vendor>`; the confirmation prompt is required in both paths. |
| P2-3 forward refs to cloud sync / Hermes pairing | Removed from README. |

## Acceptance criteria

See build prompt §13. Branch is mergeable when those pass and Codex has signed off in writing (`tasks/usrcp-stream-codex-review.md`).
