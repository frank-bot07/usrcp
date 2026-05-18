# Lift scope-enforcement wrapper into a shared module

Date: 2026-05-18
Branch: `feat/shared-scope-enforcement`

## Why

Pre-this-PR, both `usrcp-local/src/server.ts` and `usrcp-stream/src/register.ts` had their own copy of:

- `resolveScopes` / `resolveStreamScopes` (the legacy-`scopes` + asymmetric flag resolver)
- `outOfScopeResponse` (the OUT_OF_SCOPE response envelope)
- The wrapper loop that gates registration on `writeScopes === []` and wraps every handler with the per-call scope check

The copies started identical and stayed identical AFTER #61 - but the only reason they did is because codex caught the four bypasses on PR #61 (rounds 1-4) when the stream copy was missing a feature the local copy had. Chad flagged it explicitly in his PR #62 review:

> Codex round-1 on the MCP scope hardening caught a real scope bypass in usrcp-stream because each package had its own copy of the scope-enforcement wrapper. That's a structural smell, not a one-off bug. Lift the wrapper into a shared util in usrcp-local (or a new usrcp-scopes package) and import it from both. Next adapter that ships scope-aware tools will hit the same trap otherwise.

This PR closes that smell. The shared implementation lives in one place; the bypass class becomes a one-place change.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where does the shared module live? | `packages/usrcp-local/src/scope-enforcement.ts` | Stream already imports `usrcp-local/dist/ledger/index.js`. Adding `usrcp-local/dist/scope-enforcement.js` is the same shape of coupling. A dedicated `usrcp-scopes` package would be heavier (extra build, extra publish) for marginal isolation benefit. |
| AuditSink interface | Structural type, only `logAudit` | The wrapper only uses logAudit. Importing the full Ledger class would couple stream to usrcp-local more than necessary. Structural interface matches Ledger by shape. |
| StreamServeOptions | Aliased to `ServeOptions` | Both packages used the same field set already. The separate type name is kept (now an alias) so external callers who imported `StreamServeOptions` don't break. |
| Single shared `ScopedToolDef` type | Yes, exported from shared module | Both packages' tool tables conform to it. usrcp-stream's `StreamToolDef` is structurally compatible (same fields). |
| Backward-compat re-export | `server.ts` re-exports `ServeOptions`/`ResolvedScopes`/`resolveScopes`/`registerToolsWithScopes` | The CLI flag parser in index.ts and dozens of tests import `ServeOptions` from `./server.js`. The re-export keeps that path working while the implementations move. |

## Surface area

**New:**
- `packages/usrcp-local/src/scope-enforcement.ts` (~260 lines)
  - `ServeOptions`, `ResolvedScopes`, `ToolKind`, `ScopedToolDef` types
  - `AuditSink` interface (structural; matches Ledger's logAudit shape)
  - `resolveScopes(opts)` - lifted from server.ts verbatim
  - `outOfScopeResponse(toolName, requested, allowed)` - lifted from server.ts verbatim
  - `registerToolsWithScopes(server, defs, opts, ledger)` - replaces both `registerAll` in usrcp-local and the inline wrapper loop in usrcp-stream
- `packages/usrcp-local/src/__tests__/scope-enforcement-shared.test.ts` (16 tests)
  - Direct tests of the shared helpers without going through createServer / registerStreamTools wiring
  - Pins the contract independent of caller wiring

**Modified:**
- `packages/usrcp-local/src/server.ts`
  - Deleted ~120 lines: `ServeOptions` interface body, `ResolvedScopes` interface body, `resolveScopes` function body, `outOfScopeResponse` function body, `registerAll` function body, `ToolKind` + `ToolDef` types
  - Added thin re-export block of the shared types/functions for back-compat
  - `createServer` now calls `registerToolsWithScopes(...)` directly (was `registerAll(...)`)
- `packages/usrcp-stream/src/register.ts`
  - Deleted ~100 lines: `resolveStreamScopes` function body, the inline wrapper for-loop, `outOfScopeResponse` function body
  - `StreamServeOptions` is now a type alias for the shared `ServeOptions`
  - `registerStreamTools` calls `registerToolsWithScopes(...)` directly
  - Imports from `usrcp-local/dist/scope-enforcement.js` (sibling-package import; same convention as the existing Ledger import)

## Test plan

- `(cd packages/usrcp-local && npm test)` -> 473/473 pass (was 457; +16 new shared-module tests)
- `(cd packages/usrcp-stream && npm test)` -> 125/125 pass (unchanged - the prior round-5 tests still validate end-to-end behavior, now flowing through the shared module)

## What this prevents going forward

Per [[feedback_duplicated_wrappers_are_structural_smell]]: the next adapter that ships scope-aware MCP tools imports `registerToolsWithScopes` and gets the same enforcement everyone else does. No second copy to drift, no codex-rounds-of-bypass-hunting on a fresh consumer. The wrapper's invariants (write-scopes empty = strip mutating; readonly wins; writeScopes ⊆ readScopes; etc.) are all enforced in one file with one test suite.

## Out of scope (follow-ups)

- Migrating `StreamServeOptions` callers to import `ServeOptions` from the shared module directly. The alias works fine; the rename is cosmetic.
- Extracting `usrcp-local/scope-enforcement.ts` into its own `usrcp-scopes` package. Considered, deferred - the current location is fine for v1; only worth doing if a third consumer ever appears (and even then, "stream already imports from usrcp-local" is the established pattern).
