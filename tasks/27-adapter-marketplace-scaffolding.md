# Adapter marketplace scaffolding

Date: 2026-05-17
Branch: `feat/adapter-marketplace-scaffolding`

## Why

Three parallel hardcoded lists drove adapter handling pre-this-PR:

1. `KNOWN_ADAPTERS` (in `setup.ts`) - the wizard catalog.
2. `ADAPTERS_REQUIRING_MASTER_KEY` (in `setup.ts`) - the master-key gate for `usrcp setup --adapter=<name>`.
3. `ADAPTERS_WITH_ENCRYPTED_CONFIG` (in `rotate-adapter-configs.ts`) - participating adapters for the rotate-key hook.

Each new encrypting adapter (#54 gcal/gmail/linear, #55 discord/slack/telegram, #57 github) had to remember to update all three lists. Codex caught two of these drifts during the rounds (#54 and #55 both shipped fixes for "I added the encrypt path but forgot the rotate-key list"). The fix-by-class is: derive everything from a single source of truth.

Per [[project_usrcp_adapters_as_addons]], the long-term direction is "marketplace-style add-ons" where external `usrcp-adapter-*` packages can be installed via npm and register themselves. This PR is the first half: define the contract and the discovery mechanism. The second half (a `usrcp adapter add <package>` CLI command + npm-side conventions for publishing) is a follow-up.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Schema location | New `packages/usrcp-local/src/adapters/registry.ts` | Single source for the contract type, the built-in list, the external loader, and the derived accessors. |
| Discovery mechanism | `~/.usrcp/adapters.json` (hand-edited or future CLI-managed) | Simple, debuggable, lives alongside the per-adapter config files for the existing backup/snapshot story. Alternative options (auto-scan `node_modules`, package.json metadata) deferred - this works for v1. |
| Built-in migration | Hardcoded `BUILTIN_ADAPTERS` array in registry.ts, NOT per-adapter manifest files | Avoids touching 9+ adapter packages. The contract is established; per-adapter manifest extraction is a follow-up PR (one per adapter, low-risk). |
| `KNOWN_ADAPTERS` back-compat | Proxy that delegates to `getRegisteredAdapters()` per access | Lets `import { KNOWN_ADAPTERS } from "./setup.js"` keep working without changing dozens of call sites. Mutations rejected (throws). |
| `ADAPTERS_WITH_ENCRYPTED_CONFIG` back-compat | Frozen snapshot at module-load time, kept as deprecated export | Same back-compat reason. New code uses `getRotateKeyAdapterValues()` so external adapters participate without restart. |
| Builtin-internal adapters | New `builtinInternal: true` flag | The trio `terminal`, `mcp-agent`, `openclaw` live inside usrcp-local rather than as sibling packages and bypass the dispatcher. The flag is reserved - external adapters that try to set it are rejected by `loadExternalAdapters`. |
| External package resolution | `packageName` manifest field, default `usrcp-<value>` | Lets external adapters use a different npm name (`usrcp-adapter-notion`) than their `value` (`notion`). The dispatcher first tries the monorepo path, then falls back to `require.resolve`. |
| Bad/missing `adapters.json` behavior | Log + skip, never throw | A broken external registry must not block `usrcp setup` from running for the built-in adapters. |
| Shadow protection | External `value`s that match a built-in are dropped with a warning | A malicious external adapter shouldn't be able to hijack a built-in `value` (e.g. `github`) by registering first. Built-ins always win. |

## Surface area

**New:**
- `packages/usrcp-local/src/adapters/registry.ts` (~280 lines)
  - `AdapterManifest` contract type
  - `BUILTIN_ADAPTERS` - the in-tree list, with full manifests
  - `loadExternalAdapters()` - tolerant JSON loader
  - `getRegisteredAdapters()` - unified built-in + external view
  - `findAdapter()`, `getMasterKeyRequiringAdapterValues()`, `getRotateKeyAdapterValues()`, `resolveAdapterPackageName()` - derived helpers
- `packages/usrcp-local/src/__tests__/adapter-registry.test.ts` (18 new tests)

**Modified:**
- `packages/usrcp-local/src/setup.ts`
  - Replaced inline 100+-line `KNOWN_ADAPTERS` array with a back-compat Proxy that delegates to the registry.
  - Removed `ADAPTERS_REQUIRING_MASTER_KEY` local Set; derived per call via `getMasterKeyRequiringAdapterValues()`.
  - `callAdapterSetup` resolves `setupFunction` from manifest (no more camelCase-derivation-from-name); resolves the package path via the monorepo-first, npm-fallback strategy.
  - `AdapterSpec` is now an alias for `AdapterManifest`.
- `packages/usrcp-local/src/rotate-adapter-configs.ts`
  - `ADAPTERS_WITH_ENCRYPTED_CONFIG` kept as deprecated frozen snapshot for back-compat; new code uses `getRotateKeyAdapterValues()` (re-derived per call).
  - `defaultResolver` checks monorepo path first, falls back to `require.resolve` for external adapters.
  - Builtin-internal adapters are filtered out automatically by the registry-derived list.

**Tests:**
- 18 new tests for the registry (BUILTIN_ADAPTERS invariants, external loading, malformed-file tolerance, shadow protection, derived helpers, `resolveAdapterPackageName`).
- Existing rotate-adapter-configs invariant test updated to document its new role (snapshot guard against accidental `supportsRotateKey` removal).
- All 433 pre-existing tests continue to pass unchanged (Proxy-based `KNOWN_ADAPTERS` keeps every consumer working).

## Verification

- `(cd packages/usrcp-local && npm test)` -> 451/451 pass (was 433 in main; +18 new registry tests).
- No adapter package changed; their tests are unaffected by definition.

## What's NOT in this PR (follow-ups)

- **Per-adapter manifest extraction**: each in-tree adapter still has its manifest hardcoded in `registry.ts`. Migrating them to export their own manifest from `packages/usrcp-<name>/src/manifest.ts` is a per-package follow-up. Doesn't change behavior; just relocates the source-of-truth from one place to one-per-package.
- **`usrcp adapter add <package>` CLI**: operators register external adapters by hand-editing `~/.usrcp/adapters.json`. A CLI helper that runs `npm install` + appends the manifest is a small follow-up PR.
- **Auto-discovery**: scan `node_modules` for packages with `usrcp-adapter` in their package.json `keywords`. Considered, deferred - the explicit-registration path is more debuggable for v1.
- **Adapter-version negotiation**: manifests have no `manifest_version` field. Add when the contract evolves.

## How to register an external adapter (for adapter authors)

1. Build your package. Export `runMyAdapterSetup` from `dist/setup.js` and optionally `reencryptConfigUnderNewKey` from `dist/config.js`.
2. `npm install usrcp-adapter-myname` (alongside `usrcp-local`).
3. Add an entry to `~/.usrcp/adapters.json`:

```json
{
  "adapters": [
    {
      "value": "myname",
      "name": "My Custom Surface",
      "blurb": "Capture <X> from <Y>. Requires <Z>.",
      "setupFunction": "runMyAdapterSetup",
      "requiresMasterKey": true,
      "supportsRotateKey": true,
      "packageName": "usrcp-adapter-myname"
    }
  ]
}
```

4. `usrcp setup --adapter=myname` (or run the interactive wizard - your adapter appears in the list).

The manifest contract is defined in `packages/usrcp-local/src/adapters/registry.ts:AdapterManifest`.
