# Task 33 — Promote `usrcp-cli` and `usrcp-core` from reserved names to real packages

Date: 2026-06-29
Status: **approved — design brief / plan of record** (not yet implemented)
Against: `main` @ #107 (packages live on npm at 0.1.8)

## The one rule for this task

**Nothing user-facing changes. Behavior stays byte-for-byte identical.** Same
install command, same `usrcp` commands, same opt-in adapter model, same
encryption, same on-disk format, same MCP tool surface. This is an *internal*
reorganization of code that today lives in one package, plus a leaner install.
If a user could tell the difference (other than a smaller adapter download),
we did it wrong. The Task 32 demo script passing unchanged is the gate.

This is NOT a fork, a rewrite, or a product change. It is moving existing,
working code into smaller packages so an adapter doesn't drag in machinery it
never uses.

## Why do it at all (the only benefit)

Today `usrcp-local` is a **7,015-line monolith** (`packages/usrcp-local/src/*.ts`)
bundling four separable concerns. **13 packages depend on it**, and every adapter
depends on the *whole thing* just to import the crypto + ledger surface
(`usrcp-adapter-kit` imports `usrcp-local`, `usrcp-local/dist`,
`usrcp-local/encryption`). So installing one small adapter (e.g. Gmail) also
pulls in code it never touches:

- `@modelcontextprotocol/sdk` (the MCP server)
- `@inquirer/prompts` + `qrcode-terminal` (the interactive CLI wizard)
- `better-sqlite3` — a **native binding** with a `postinstall` rebuild hack in
  `usrcp-local/package.json`.

After the split, an adapter depends only on the small engine. Smaller download,
fewer third-party libraries riding along, easier to audit. That is the entire
payoff. It reinforces the already-established "independent + secure + opt-in"
posture; it does not introduce it.

## Current state — four concerns inside `usrcp-local`

| Concern | Files | ~LOC | Destination |
| --- | --- | --- | --- |
| **Protocol core** (framework-agnostic crypto + ledger) | `encryption.ts` (745), `crypto.ts` (186), `scope-enforcement.ts` (671), `pair.ts` (716), `rotate-identity.ts` (245), `types.ts` (130), `config.ts` (43), `ledger/` (core 714, events 563, keys 509, snapshot 376, identity 335, timeline 241, facts 189, audit 121, helpers 68) | ~5,900 | **`usrcp-core`** |
| **MCP server** | `server.ts`, `transport.ts` | — | stays `usrcp-local` |
| **CLI** | `index.ts` command switch (`init`, `serve`, `status`, `users`, `sync`, `pair`, `rotate-identity`, `config`, `adapter`, `keychain`, `setup`, `snapshot`, `restore`), `setup.ts` (inquirer wizard), `keychain.ts` | ~1,600 | **`usrcp-cli`** |
| **Cloud sync** | `sync.ts` | — | stays `usrcp-local` |

`usrcp-sdk` (the top-level `sdk/` package) is already independent and does NOT
import `usrcp-local`. `usrcp-core` is the lower-level protocol library, not the SDK.

## Target package boundaries

- **`usrcp-core`** — the vault engine: encryption, ledger, crypto, pairing,
  identity rotation, scope enforcement. No MCP SDK, no inquirer, no CLI.
  Exports the same subpaths `usrcp-local` exposes today: `.`, `./encryption`,
  `./ledger`, `./crypto`, `./pair`, `./rotate-identity`, `./scope-enforcement`.
- **`usrcp-local`** — stays the MCP server (`server.ts`, `transport.ts`, the
  `serve` command). What MCP clients spawn. Depends on `usrcp-core`.
- **`usrcp-cli`** — the human command-line tool (`init`, `status`, `users`,
  `pair`, `rotate-identity`, `config`, `adapter`, `keychain`, `setup`,
  `snapshot`, `restore`). Depends on `usrcp-core` + `usrcp-local`.
- **`usrcp` (umbrella)** — repoint `release/extra-names/usrcp` from
  `usrcp-local@^0.1.8` to `usrcp-cli`, so `npm i -g usrcp` still yields the full
  human CLI.

## Decision (kept low-risk to honor "behavior stays the same")

**`better-sqlite3` placement:** for this pass, `usrcp-core` keeps the
`better-sqlite3` dependency exactly as the ledger uses it today — **no storage
abstraction, no behavior change.** This guarantees identical runtime behavior.
The only net change vs today: an encryption-only consumer still won't avoid the
native build *in this pass* if it imports the ledger; adapters that import only
`encryption` will, because `encryption.ts` has no sqlite dependency.

> Deferred (optional, separate future task): introduce a `Storage` interface so
> the native sqlite module is isolated to a thin package and pure-crypto
> consumers skip the native build entirely. Bigger win, but it touches
> `ledger/core.ts`/`keys.ts`/`events.ts` and risks behavior drift — out of scope
> here precisely because of the "nothing changes" rule. If we do it, it ships as
> its own task with its own regression pass, not bolted onto this one.

## Back-compat (hard requirements — break these and real setups break)

- `usrcp-local`'s `package.json` maps **both** bin names `usrcp-local` AND
  `usrcp` to `dist/index.js`. Live MCP client configs spawn these. After the
  split, `usrcp serve` and `usrcp-local serve` must resolve and behave
  identically. `serve` stays in `usrcp-local`; `usrcp-cli` delegates to it.
- On-disk layout, key-file perms (0o600), ledger DB format, and the MCP tool
  surface do not change.

## Non-goals

- No rewrite of crypto/ledger/scope logic — move it, re-verify it, don't reauthor.
- No on-disk format or MCP API change.
- No storage abstraction this pass (see decision above).
- `usrcp-sdk` stays separate.
- No new features. Pure structural extraction.

## Migration plan (incremental, verify after each step)

1. Create `packages/usrcp-core`; move the protocol files; set its export map to
   match today's `usrcp-local` subpaths. Build green, tests move with the code.
2. Make `usrcp-local` depend on `usrcp-core` and re-export the moved subpaths so
   the 13 dependents keep building unchanged. **Run the full suite — green.**
3. Migrate dependents (adapters, stream, extension, claude-code, adapter-kit)
   from `usrcp-local/encryption` → `usrcp-core/encryption`. Remove the
   re-export shim in the same arc (no indefinite shim).
4. Create `packages/usrcp-cli`; move the human command handlers + `setup.ts` +
   `keychain.ts`; depend on `usrcp-core` + `usrcp-local`.
5. Repoint the `usrcp` umbrella to `usrcp-cli`.
6. Replace the `0.0.1` placeholder stubs (`release/extra-names/usrcp-cli`,
   `usrcp-core`) with real `packages/` entries; bump to the next release line
   (0.1.9 or 0.2.0); wire into `scripts/release/publish.mjs` dep order + the
   Linux publish job.

## Acceptance criteria

- ✅ `usrcp-core` builds, publishes, exposes the same subpaths `usrcp-local` does today.
- ✅ All 13 former `usrcp-local` dependents import protocol code from
  `usrcp-core`; a fresh `npm i` in one adapter shows it no longer pulls
  `@modelcontextprotocol/sdk` or `@inquirer/prompts`.
- ✅ `usrcp-cli` builds and publishes; `npm i -g usrcp` (umbrella → cli) gives
  every human command working identically to today.
- ✅ `usrcp serve` and `usrcp-local serve` both still launch the MCP server; an
  existing Claude Desktop config spawning `usrcp` connects unchanged.
- ✅ **Task 32 demo script passes end-to-end, unchanged**, on a clean tmp HOME.
  This is the behavioral regression gate.
- ✅ Full test suite green; tests moved with the code they cover.
- ✅ npm `latest` for `usrcp-cli` / `usrcp-core` is the real package, not the
  `0.0.1` placeholder.
