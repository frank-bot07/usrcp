# MCP scope hardening - asymmetric read/write permissions

Date: 2026-05-17
Branch: `feat/mcp-scope-hardening`

## Why

Today's MCP scope model has three primitives:

- `--scopes coding,work` - the agent can read AND write to those domains.
- `--readonly` - strips all mutating tools entirely.
- `--no-audit` - strips the audit-log tool.

This forces every agent to a single privilege level per domain. There's no way to express "this agent can read everything for context but only write to {personal}" - which is exactly the shape you want for an autonomous-writes flow ([[project_usrcp_autonomous_writes]]) where one agent gathers full-ledger context and another performs targeted writes.

This PR adds asymmetric read/write scope flags so operators can carve out narrower privilege envelopes.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| New flags | `--read-scopes` and `--write-scopes` | Mirror the symmetric `--scopes`; semantics obvious from the name. |
| Legacy `--scopes` behavior | Unchanged | Backward compat is non-negotiable. The old flag still works as a symmetric shortcut. |
| Mix legacy + new flags? | Reject as ambiguous | `--scopes X` is symmetric; passing it alongside `--write-scopes Y` is contradictory. Better to fail fast than silently pick one. |
| `--read-scopes X` alone (no write flag)? | Defaults `writeScopes` to `[]` (no writes anywhere) | "I want to constrain this agent to reading X" is the obvious read of the flag. Without this default, the operator who typed `--read-scopes X` without `--write-scopes` would get writes-everywhere - the opposite of safety. |
| `--write-scopes X` alone (no read flag)? | Defaults `readScopes` to `undefined` (unrestricted reads) | Writing without read access on the same domain is functionally broken (the agent can't see what it wrote). Either we'd default write-scopes-imply-same-read (forcing the read scope), or leave reads unrestricted. The latter is more useful: it lets an agent gather context across all domains and write only to a constrained sub-domain. |
| `--readonly` priority | Always wins, overriding any `--write-scopes` | `--readonly` is the strongest no-writes signal. Combining it with `--write-scopes X` would be contradictory; rather than error, we let `--readonly` override (write-scopes becomes `[]`). |
| Validate `writeScopes ⊆ readScopes`? | Yes, at server-construction time | A write on a domain you can't read is operationally weird; force the operator to be explicit. Empty `writeScopes` is trivially a subset, so the check skips that case. |
| Audit row format on dual scopes | `read=[...];write=[...]` compound string | Distinguishes the two without coupling the audit-log format to the read/write split everywhere downstream. |
| Strip mutating tools when `writeScopes === []`? | Yes, at registration time | Same UX as `--readonly`: a writeless agent shouldn't see tools it can't use in `tools/list`. The wrapper-time enforcement is the backup for non-empty `writeScopes` cases. |

## Surface area

**Modified:**

- `packages/usrcp-local/src/server.ts`
  - `ServeOptions` extended with `readScopes` and `writeScopes`.
  - Replaced `effectiveScopes` with the new exported `resolveScopes(opts)` that returns `{ readScopes, writeScopes }` and throws on inconsistency.
  - `createServer` now references `readScopes` from the closure (replacing the old `scopes` variable in the handlers for `get_state`, `search_timeline`, and `status`).
  - `registerAll` enforces `writeScopes` for mutating tools and `readScopes` for read tools, distinguished via `def.mutating`. Empty `writeScopes` triggers registration-time stripping (same path as the old `--readonly`).
  - Audit `scopes_accessed` field now records the compound `read=...;write=...` string when any scope flag is set.
- `packages/usrcp-local/src/index.ts`
  - CLI parses `--read-scopes` and `--write-scopes` (mutex-checked against `--scopes`).
  - Help text covers the new flags with worked examples.
  - `formatScopeBanner` includes the new flags in the startup line.
- `packages/usrcp-local/src/__tests__/scope-enforcement.test.ts`
  - New `describe("asymmetric scopes")` block with 10 tests covering: tools-list stripping under `--read-scopes` alone, read constraint, unrestricted reads under `--write-scopes` alone, asymmetric subset enforcement, write-scopes ⊆ read-scopes validation, mutual-exclusion errors, `--readonly` override, empty read-scopes normalization, audit row format.
  - One existing CLI subprocess test had its error-string assertion generalized to match the new shared error message.

## Verification

- `(cd packages/usrcp-local && npm test)` -> 433/433 pass (was 422 in main).
- `(cd packages/usrcp-stream && npm test)` -> 114/114 pass (was 107 in main).
- Other adapter packages: unaffected.

## Codex round-1 fixes (P1, P2)

Codex caught two issues in round-1:

**P1**: usrcp-stream's `registerStreamTools` had its own copy of the scope-enforcement wrapper and only read `serveOptions.scopes` / `serveOptions.readonly` - not the new `readScopes` / `writeScopes`. Result: an agent launched with `--read-scopes=coding` would correctly strip `usrcp_append_event` (local) but `stream_capture` would remain unscoped, and `--write-scopes=personal` would leave `stream_recall` able to read every surface. Real scope bypass.

Fix: Extended `StreamServeOptions` with `readScopes` / `writeScopes`. Added `resolveStreamScopes` (mirrors usrcp-local's `resolveScopes` inline rather than importing - keeps the packages loosely coupled across version boundaries; the semantics MUST stay in sync). Switched the wrapper to route reads through `readScopes` and writes through `writeScopes` based on `def.mutating`, matching the local-side logic. Switched `streamRecall` / `streamThread` scope-wall injection to use `readScopes` (it's a multi-domain-read).

usrcp-local's createServer already passes the full `opts` to stream, so no caller-side change was needed once stream understood the new fields.

7 new stream tests cover: tools-list stripping under `--read-scopes` alone, read constraint enforcement, unrestricted-reads-under-write-only, asymmetric subset enforcement on stream tools, mutex error, write ⊆ read validation.

**P2**: Legacy callers passing `createServer({ scopes: [] })` previously got "unrestricted both ways" (the old `effectiveScopes` returned undefined for any empty array). The first cut of this PR left `writeScopes: []`, which would strip every mutating tool - a regression for any caller relying on the empty-array convenience.

Fix: Normalize `opts.scopes = []` to `undefined` BEFORE the legacy alias step. Explicit `writeScopes: []` still means "no writes" (its dedicated sentinel for `--readonly` parity); only the legacy-`--scopes` path gets the empty-as-unrestricted convenience.

1 new local test locks the legacy `--scopes=[]` shape so this can't regress.

## Codex round-2 fix (P1, follow-on)

Round-2 spotted that the round-1 fix only covered the unified `usrcp serve` entry-point. The standalone `usrcp-stream` daemon has its own entry-point in `packages/usrcp-stream/src/server.ts` that rebuilt `serveOptions` from an explicit field list, silently dropping `readScopes` and `writeScopes`. Effect: `usrcp-stream serve --read-scopes=discord` accepted the flag but ran without the asymmetric restriction.

Fix: forward `opts` verbatim to `registerStreamTools` instead of cherry-picking fields. Two new regression tests use `createStreamServer` directly and verify:

- `readScopes: ["discord"]` strips `stream_capture` from the standalone server (writeScopes defaults to `[]`).
- `writeScopes: ["discord"]` rejects `stream_capture` to `telegram` on the standalone server.

Tests: usrcp-stream 114 -> 116.

## What this enables (worked examples)

```bash
# Cursor agent: read-only across coding/work for context-gathering:
usrcp serve --agent-id=cursor-readonly --read-scopes=coding,work --no-audit

# Autonomous personal-writer: reads everything, writes only personal:
usrcp serve --agent-id=writer --write-scopes=personal

# Reviewer agent: read everything, never write:
usrcp serve --agent-id=reviewer --readonly

# Symmetric legacy: read+write coding only:
usrcp serve --agent-id=cursor-coding --scopes=coding

# Asymmetric subset: read across {coding, work, personal}, write only personal:
usrcp serve --agent-id=mixed --read-scopes=coding,work,personal --write-scopes=personal
```

## Out of scope

- **mcp-agent wizard extension.** The interactive wizard at `usrcp setup --adapter=mcp-agent` still asks the symmetric "scopes" question. Operators who want the asymmetric setup can hand-edit the generated `args` array. A wizard extension that asks "asymmetric?" is a follow-up - the friction of two more prompts isn't worth it for the common symmetric case.
- **Per-tool grants.** No way to express "agent can call `usrcp_append_event` but not `usrcp_set_fact`". The current `mutating: true/false` bit is the only granularity. If we hit a real need for per-tool gating later, the wrapper layer is the right place to add it.
- **Time-limited scopes.** No expiry on the grants. The MCP config lives in the agent's MCP file forever until the operator rotates it. Per-call signed capabilities (Model B) is a separate, larger workstream.
