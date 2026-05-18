# usrcp-github adapter

Date: 2026-05-17
Branch: `feat/usrcp-github-adapter`

## Why

After three encryption-at-rest PRs (#54, #55, #56) the adapter
template is stable: encrypted secret + preflight + rotate-key hook
+ atomic per-file writes. Time to use it. GitHub is the most
valuable next adapter for engineer agents - "what did Chad work on
last week" is overwhelmingly answered by PR activity.

## Scope (v1)

Captures one event type: **pull requests authored by the configured
user, on `pr_opened`**.

Out of scope for v1 (deferred to a follow-up):

- Issues, discussions.
- Reviews you submitted on others' PRs.
- Commits you authored (different endpoint).
- PR state changes (`pr_merged`, `pr_closed`, `pr_reopened`).
  The cursor is on `created_at`, so each PR fires exactly once.

Per [[project_usrcp_adapters_as_addons]] (keep packages
independent) and [[feedback_code_quality.md]] (no theater, audit
adversarially before presenting), v1 is the minimum end-to-end
flow: prompt token -> validate -> persist encrypted -> poll ->
capture -> ledger. No half-built state-change pipeline that
"sort of" works.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| API: REST vs GraphQL? | REST `/search/issuesAndPullRequests` | One endpoint covers the "PRs I authored since X" query. GraphQL would require more code for marginal benefit. |
| Library: `@octokit/rest` | Pinned to `^20.1.2` (last CJS-compatible major) | Octokit v21+ is ESM-only; matching the CJS pattern of every other adapter keeps the dispatcher logic uniform. |
| Token type | Both classic PAT and fine-grained PAT supported | Same auth header, no shape difference. Fine-grained is recommended in the README. |
| Cursor field | `created_at` (not `updated_at`) | "PR captured once" semantics. `updated_at` would require dedup on every poll. v1.1's state-change layer can use a second cursor. |
| Org allowlist | Optional; empty = capture from every visible repo | Sensible default for personal use. Org filter is applied server-side via `org:<slug>` in the search query. |
| PAT at rest | Encrypted under master key, same `enc:<base64>` envelope as other adapters | Matches #54+#55 pattern; auto-migrates legacy plaintext on load; participates in rotate-key hook. |
| First-run lookback | 5 minutes | Same as linear. Catches activity in the gap between setup and daemon start. Anything older is "history" and not v1's job. |
| Poll interval default | 600s (10 min) | Search API limit is 30/min authenticated; we use ~1 req/poll. Plenty of headroom. |

## Surface area

**New package:**
- `packages/usrcp-github/`
  - `package.json` - pinned `@octokit/rest@^20.1.2`
  - `tsconfig.json` - identical to linear's
  - `README.md` - mirrors linear's structure
  - `src/config.ts` - encrypted PAT, preflight, rotate-key helper (the full template)
  - `src/setup.ts` - interactive wizard, validates against /user
  - `src/capture.ts` - pure function (no octokit dep), takes flattened activity
  - `src/index.ts` - poller daemon with recursive setTimeout + cursor
  - `src/__tests__/config.test.ts` - 22 tests
  - `src/__tests__/capture.test.ts` - 7 tests

**Wired into usrcp-local:**
- `packages/usrcp-local/src/setup.ts` - adds GitHub to `KNOWN_ADAPTERS` and to `ADAPTERS_REQUIRING_MASTER_KEY`.
- `packages/usrcp-local/src/rotate-adapter-configs.ts` - adds `"github"` to `ADAPTERS_WITH_ENCRYPTED_CONFIG`.
- `packages/usrcp-local/src/__tests__/rotate-adapter-configs.test.ts` - invariant test updated.

**CI:**
- `.github/workflows/test.yml` - adds `usrcp-github` to the
  `node-linux` matrix and to the cache-dependency-path list.

## Verification

- `(cd packages/usrcp-github && npm test)` -> 29/29 pass
- `(cd packages/usrcp-local && npm test)` still passes (invariant test bumped)

## Threat model

Same as the other token-holding adapters:

- Token on disk is encrypted under the global key derived from
  the master key via HKDF. Mode 0600 defense in depth.
- Legacy plaintext (pre-encryption, can't happen for new
  adapter but the migration code is present for symmetry with
  other adapters' shape) auto-encrypts on first load.
- Rotate-key participates via `reencryptConfigUnderNewKey`;
  registered in `ADAPTERS_WITH_ENCRYPTED_CONFIG`.

## Future PRs

- v1.1: state-change events (pr_merged, pr_closed,
  pr_reopened, review_submitted) on a separate `updated_at`
  cursor, grouped by `channel_id = <owner>/<repo>#<number>`.
- v1.2: issues + issue comments authored by user.
- v1.3: maybe pull-request review activity on others' PRs.
