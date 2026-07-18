# Scope: migrate off `better-sqlite3` → Node's built-in `node:sqlite`

**Status:** scoped, not started. **Author:** review before committing — this gates on a Node-version-floor decision.

## Why

`npm install -g usrcp` **crashes for new users on npm 12+**: npm's `allowScripts`
default blocks `better-sqlite3`'s native build, so the binary is never produced and
`usrcp init` fails with *"Could not locate the bindings file."* (See
`docs/RELEASING.md` and the 2026-07-18 finding.) Homebrew works (it rebuilds the
binding), and that's now the recommended install — but the npm path is broken for a
growing share of users, which is a bad story for a dev tool.

`node:sqlite` (Node's built-in, no native dependency, no build script) makes the npm
install **buildless** → it just works on any npm. This is the only fix that fully
unbreaks the npm path. Everything below is grounded in the actual usage surface + a
live API probe on Node 24.15, not assumptions.

## In scope vs out of scope

- **In scope (the actual product install): `usrcp-core` + `usrcp-local` + the 11
  adapters.** Confirmed: core/local do **not** use `sqlite-vec` or any extension.
  These go fully buildless.
- **Out of scope for buildless: `usrcp-stream`.** It loads `sqlite-vec` (a *native*
  `vec0` virtual-table extension) for embeddings. That's a native binary regardless
  of the SQLite driver, so stream can't be buildless. Options: keep `better-sqlite3`
  in stream, or use `node:sqlite` + `loadExtension` for sqlite-vec (Node 24 has
  `loadExtension`, **but not probed** — verify sqlite-vec loads into node:sqlite's
  bundled SQLite). Stream is the **optional** cloud/embeddings sibling, not the main
  install, so this can be decided separately/later.

## Usage surface (measured)

| API | Count | node:sqlite status |
|---|---|---|
| `.prepare()` / `.get()` / `.all()` / `.run()` | 253 / 179 / 59 / 74 | ✅ identical shape (probed); `lastInsertRowid` is a `number` |
| `.exec()` | 31 | ✅ present |
| `.pragma(str)` | 11 | ❌ **no `.pragma()`** — rewrite to `.exec("PRAGMA …")` (settings) or `.prepare("PRAGMA …").get()` (wal_checkpoint / integrity_check / secure_delete) |
| `.transaction(fn)` | ~8 sync (the `async (client)=>` ones are Postgres/`pg`, not sqlite) | ❌ **no `.transaction()`** — manual `BEGIN`/`COMMIT`/`ROLLBACK` helper |
| `new Database(path, {readonly})` | 4 (snapshot) + 2 | ⚠️ option renamed → `new DatabaseSync(path, {readOnly})` |
| SQLite statement `.bind()` | **0** | — (the only `.bind()` is `window.fetch.bind()`, not sqlite) |
| `.pluck()` / `.raw()` / `.safeIntegers()` / `.function()` / `.aggregate()` / `.backup()` | **0** | — none used (snapshot uses `fs.copyFileSync`, not `.backup()`) |
| `.iterate()` | **0** | — |

## Probed behavioral differences (Node 24.15, live)

1. **Rows are null-prototype objects** (`[Object: null prototype]`). Safe here — code
   accesses rows by property (`row.foo`); grep found no `hasOwnProperty` / `Object.keys(row)`
   / row-spread. Flag for JSON/serialization edges.
2. **Integers > 2^53 THROW** `ERR_OUT_OF_RANGE` (better-sqlite3 returns a lossy number).
   USRCP's integer columns (`ledger_sequence` counter, rowids, ms timestamps) all stay
   well under 2^53, so this won't trigger — but it's a real strictness difference; the
   235 core tests are the safety net, and node:sqlite has a per-statement BigInt opt-in
   if ever needed.
3. Named params (object binding) and positional `?` both work.

## Strategy: a thin compatibility shim (keeps blast radius small)

Do **not** rewrite 253 call sites. Add one wrapper in `usrcp-core` (e.g.
`src/ledger/sqlite.ts`) — a `Database` class over `node:sqlite`'s `DatabaseSync` that
presents the better-sqlite3 surface the code already uses:

- constructor maps `{readonly}` → `{readOnly}`
- `.prepare()` returns a statement exposing `.get/.all/.run` (pass-through)
- `.exec()`, `.close()` pass through
- `.pragma(str)` → `.exec("PRAGMA "+str)`, or `.prepare("PRAGMA "+str).get()` for the
  value-returning ones (`wal_checkpoint(TRUNCATE)`, `integrity_check`, `secure_delete`)
- `.transaction(fn)` → `BEGIN`/`COMMIT`/try-`ROLLBACK` wrapper (verify **no nested**
  transactions first — the manual wrapper has no savepoint nesting; grep suggests each
  file has separate, non-nested transaction sites, confirm before relying on it)

Then swap **3 imports** (`core.ts`, `snapshot.ts`, and stream's `db/index.ts` if
migrated), drop `better-sqlite3` from the 14 package.jsons, and **delete the 14
`npm rebuild better-sqlite3` postinstall hacks**. The 253 call sites are untouched.

## Node version floor (empirically re-tested — milder than first thought)

**Corrected 2026-07-18 by testing Node 22.23.1 directly** (an earlier draft here
wrongly claimed Node 22 needed `--experimental-sqlite` and was "unusable" — that was
true only for the *early* 22.5 release):

- **Node 22 (current LTS): `node:sqlite` works with NO flag.** Verified: plain
  `node script.mjs` on 22.23.1 runs `DatabaseSync` fine. It only prints
  `ExperimentalWarning: SQLite is an experimental feature…` to stderr (suppressible
  via `--no-warnings`, `NODE_NO_WARNINGS=1`, or filtering the `warning` event in the
  CLI entrypoint), and it's officially "experimental" (API could shift between 22.x
  patches).
- **Node 24+: stable, unflagged, no warning.**

So the realistic `engines` floor is **`>=22` (drop only 18/20)** — Node 22 is current
LTS, so this excludes almost nobody. On Node 22 we'd suppress the experimental warning
in the CLI; the "experimental" API caveat is the only residual (mitigated by the full
test suite catching any drift, and by recommending Node 24 where possible).

- **Cost:** drop Node 18/20 (both EOL/near-EOL by mid-2026). The "experimental" status
  on Node 22 is a minor caveat, not a blocker.
- **Benefit:** `npm install` works on any npm, buildless — the launch blocker fully
  fixed, and the install footprint drops (no native module, no compiler, no prebuild).

This makes the migration a **much easier call** than a hard `>=24` floor would have.

## Risks

1. **Node 24 floor** (above) — the biggest, and it's a product call.
2. **Maturity gap.** better-sqlite3 is 10+ years battle-tested; node:sqlite is young.
   Subtle differences in WAL, busy-timeout, integer coercion, error messages. The
   ledger is security/correctness-critical (crypto, key rotation, WAL durability), so
   this needs the full 235 core + 322 local suite green + manual crash-recovery checks.
3. **Performance.** better-sqlite3 is famously fast; node:sqlite is competitive but
   unbenchmarked here. Measure before/after on the hot paths (append_event, blind-index).
4. **stream + sqlite-vec via node:sqlite `loadExtension`** — unprobed; may keep stream
   on better-sqlite3.
5. **busy_timeout / concurrency** — verify node:sqlite honors the settings the code
   relies on (multiple MCP clients hitting one ledger).

## Phased plan + effort

1. **Shim + core migration** (~1–1.5 d): build `sqlite.ts`, swap core.ts/snapshot.ts,
   run the 235 core tests + manual rotation/crash-recovery checks. Verify pragmas,
   transactions, integer edges.
2. **usrcp-local + adapters** (~0.5 d): they use core's DB; mostly drop `better-sqlite3`
   + the postinstall hack, bump engines, run 322 local tests.
3. **CI + docs + deps** (~0.5 d): drop Node 22 from matrix, bump `engines`, remove
   `better-sqlite3` deps + postinstall hacks, flip README back to **npm-primary**
   (the whole point), update RELEASING.
4. **stream decision** (~0.5–1 d, separate): keep better-sqlite3, or node:sqlite +
   sqlite-vec loadExtension (verify first).
5. **Benchmark + soak** before declaring done.

**Total: ~2–4 days** for the main install, with the security-critical ledger demanding
careful testing. **Not launch-week** — it's a deliberate post-launch hardening that
*earns back* the npm-primary install story.

## Recommendation

Bounded and worth doing — the compat-shim keeps it small, it's the only real fix for
the npm path, and the version-floor objection largely evaporated on testing (Node 22
works; floor is `>=22`, not `>=24`). The remaining reason to not rush it is that the
ledger is **security/correctness-critical** (crypto, key rotation, WAL durability), so
it needs the full 235+322 suite green plus manual crash-recovery + a perf benchmark —
work that shouldn't be crammed in pre-launch. For launch, Homebrew-primary (shipped in
v0.2.4) is the right call; this migration is what earns npm-primary back afterward,
and with the floor concern resolved it's a strong post-launch candidate.
