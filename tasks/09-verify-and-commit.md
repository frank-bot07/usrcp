# Task 09 — Verify the v0.2 work and commit it cleanly

**Repo:** `/Users/frankbot/usrcp/`.

## Context

A previous session implemented tasks 01–08 from this directory and reported "236 passing tests." When the user re-ran tests on this machine, the suite was actually in catastrophic failure — 147 tests failed of 216, with cascading errors across `audit`, `ledger`, `security`, `server`, `sync`, `tamper`, and `clients` test files.

Investigation showed the failures are **environmental, not code**: `better-sqlite3`'s native binding was compiled against `NODE_MODULE_VERSION 141` (Node 22) but the system runs `NODE_MODULE_VERSION 137` (Node 20), so every test that touches the SQLite database errors at module load. Tests that don't touch the database (`crypto.test.ts`, `config.test.ts`) pass.

Additionally, the working tree currently has:
- 20 modified files (source + tests + docs across all of `packages/usrcp-local/` plus `README.md`, `docs/SECURITY.md`, `spec/PROTOCOL.md`, `strategy/PITCH.md`, `strategy/GTM.md`, `sdk/QUICKSTART.md`, `sdk/README.md`)
- 9 new files (`packages/usrcp-cloud/`, `docs/INTEGRATIONS/`, `strategy/INTEGRATIONS.md`, `strategy/SEARCH_DECISION.md`, plus new test/source files for sync, transport, multiuser, config, clients)
- Nothing committed since `1eb42d5 Add task 00: Discord end-to-end vision demo`

The user has signed off on **Path B** for task 03 (structured-memory positioning, no semantic embeddings). Docs sweep for Path B has already been done across README, PITCH, GTM, PROTOCOL, SECURITY — all five files consistently disclaim semantic memory.

## Goal

Three things, in order:

1. **Get the test suite genuinely green on this machine.**
2. **Verify each of tasks 01, 02, 04, 05, 06, 07, 08 actually does what its brief said it should.**
3. **Commit the work in logical, scoped chunks** — one commit per task, not a single mega-commit, so the history is reviewable and revertible.

## What to do

### Step 1 — Fix the environment

```bash
cd /Users/frankbot/usrcp/packages/usrcp-local
npm rebuild better-sqlite3
```

If the rebuild fails (missing build tools, node-gyp issues), report what's needed and stop. **Don't attempt fragile workarounds** like deleting `node_modules` or pinning a different sqlite version without telling the user.

After rebuild, run:
```bash
npm test 2>&1 | tail -30
```

Expected: dramatic recovery. If still red, investigate the actual failures (now visible without the SQLite cascade) and report.

### Step 2 — Verify each task is real

For each of the briefs in `tasks/01-*.md` through `tasks/08-*.md` (skip 03 — docs-only, already verified), check that the implementation actually matches the brief. Do not just check that files exist — open them and confirm the substance.

Per task, write a short verification report (≤5 lines each) covering:

- **What was implemented** (file paths, key functions/columns added)
- **Whether it matches the brief's "what to do" section** (yes / partial / no — be honest)
- **Whether tests for it exist and pass** (test file path, count of passing tests for that area)
- **Anything missing or off-spec** worth flagging before commit

Specific things to check:

| Task | What to verify |
|---|---|
| **01** | `bin` entry in `package.json`, `init` command auto-detects Claude Code config and registers MCP server, idempotent on re-run |
| **02** | `schemaless_facts` table exists in schema, ledger methods (`setFact`/`getFact`/`listFacts`/`deleteFact`), MCP tools (`usrcp_set_fact`/`usrcp_get_facts`), tests cover write/read/isolation/rotation |
| **04** | `version` columns on identity/preferences/domain_context/schemaless_facts, `expected_version` parameter on update tools, `VERSION_CONFLICT` error path, "Concurrency Model" section in `spec/PROTOCOL.md` |
| **05** | `--transport=http` mode in CLI, TLS cert generation in `~/.usrcp/tls/`, bearer token in `~/.usrcp/auth.token` with `0600`, timing-safe comparison, `SECURITY.md` updated to retract stdio-plaintext caveat |
| **06** | `packages/usrcp-cloud/` is a real Fastify/Hono server (not a stub), endpoints from spec, ciphertext-only enforcement, Ed25519 request signing, `usrcp sync push/pull/status` CLI commands |
| **07** | `docs/INTEGRATIONS/` has at least one editor walkthrough (Cursor preferred), `strategy/INTEGRATIONS.md` tracker exists with real entries, demo artifact exists or is acknowledged as missing |
| **08** | `~/.usrcp/users/<slug>/` layout, `--user` flag in `init` and `serve`, migration from old layout, `multiuser.test.ts` covers isolation + migration |

Report all findings in a single write-up before any commits.

### Step 3 — Commit in logical chunks

Once Step 2 is done and the user has reviewed the verification report, propose a commit plan: one commit per task, with messages that reference the task brief by number. Example:

```
git add packages/usrcp-local/src/ledger.ts \
        packages/usrcp-local/src/__tests__/ledger.test.ts \
        spec/PROTOCOL.md
git commit -m "Task 04: concurrency model + optimistic locking

Add version columns to identity/preferences/domain_context/schemaless_facts.
Add expected_version parameter on update tools with VERSION_CONFLICT error.
Document concurrency model in PROTOCOL.md §11.

See tasks/04-conflict-semantics.md for full brief.
"
```

Confirm the plan with the user before running the commits.

The Path B docs sweep (changes to README, PITCH, GTM, PROTOCOL, SECURITY for task 03) should be its own commit referencing `strategy/SEARCH_DECISION.md`.

## Out of scope

- **Don't start task 00 (Discord adapter) in this session.** That's a separate next move once this one is clean.
- **Don't push to `origin/main`** — leave commits local. The user has not asked for a push.
- **Don't refactor or "clean up" code** that's not directly broken. The goal is to land the v0.2 work, not to improve it.
- **Don't squash** the per-task commits into a single one. The user wants separable history.

## Acceptance criteria

1. `npm test` exits 0 with a passing count that matches or exceeds 236.
2. A verification report exists (in this conversation, not committed) covering tasks 01, 02, 04, 05, 06, 07, 08 with the per-task substance check.
3. User has reviewed and approved the commit plan.
4. Commits land per the approved plan, one per task.
5. Working tree is clean after commits (modulo intentional uncommitted work the user calls out).

## What to do if something is genuinely broken

If verification of any task shows the implementation is incomplete, off-spec, or has failing tests that aren't environmental:

- **Do not paper over it.** Report it as broken in the verification step.
- **Do not commit broken work** to "land it for now."
- Either fix the gap (with the user's go-ahead) or commit only the parts that work and leave the rest in the working tree with an explanation.
- The point of this task is to make reality match the recap — not to hide divergence behind a green checkmark.
