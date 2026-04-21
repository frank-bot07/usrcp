# Task 08 — Multi-user identity resolution in local mode

**Repo:** `/Users/frankbot/usrcp/packages/usrcp-local/`.

## Context

Today, `~/.usrcp/` assumes one user per machine. The moment a shared laptop or family device is in play, the abstraction breaks. **Lower priority because it doesn't bite until non-developer users arrive** — but easy to design now, painful to retrofit later.

## Goal

Allow multiple ledgers to coexist on one machine, each with its own passphrase, encryption keys, and SQLite database. No identity-resolution heuristics — user picks their slug explicitly.

## What to do

### 1. New on-disk layout

Move from:
```
~/.usrcp/
  ├── master.salt
  ├── master.verify
  ├── ledger.db
  └── ...
```

To:
```
~/.usrcp/
  └── users/
      └── <user_slug>/
          ├── master.salt
          ├── master.verify
          ├── ledger.db
          └── ...
```

### 2. CLI changes

- `usrcp init --user=<slug>` — create a new ledger for that user
- `usrcp serve --user=<slug>` — bind the MCP server to that ledger
- Default behavior:
  - If exactly one user exists, use it (backward compat after migration)
  - If zero users exist, run `init` first
  - If multiple users exist, **require** `--user` (clear error message listing available slugs)

### 3. Migration

Detect old layout on first run of the new version:

- Look for `~/.usrcp/master.key` or `~/.usrcp/master.salt` directly under `.usrcp` (not under `users/`)
- Move them into `~/.usrcp/users/default/`
- Move `ledger.db`, `mode`, and any other top-level files
- Leave a breadcrumb file `~/.usrcp/MIGRATED.md` explaining what happened
- **Don't break anyone's setup** — test the migration thoroughly

### 4. Claude Code config

When `init` registers the MCP server, register one entry per user:

```json
{
  "mcpServers": {
    "usrcp-frank": { "command": "usrcp", "args": ["serve", "--user=frank"] },
    "usrcp-jess": { "command": "usrcp", "args": ["serve", "--user=jess"] }
  }
}
```

The agent can switch contexts by selecting which server to call.

### 5. Tests

Add to `src/__tests__/`:

- Two ledgers in parallel are cryptographically isolated (passphrase A cannot decrypt user B's data)
- Migration from old single-user layout works without data loss
- `--user` selection works
- Missing `--user` with multiple users gives a clean error with available slugs
- `init --user=<existing>` refuses to overwrite

## Out of scope

- **No identity-resolution heuristics** ("which user is this based on typing patterns") — overkill, creepy
- **No shared groups** (multiple humans collaborating on one ledger) — different problem, future task
- **No OS-level user detection** — explicit slugs only

## Acceptance criteria

- Two users on one machine each get isolated, encrypted ledgers
- Old single-user installs auto-migrate without data loss on first run
- `--user` flag works in `init` and `serve`
- Tests cover isolation + migration + selection edge cases

## Files to read first

- `packages/usrcp-local/src/index.ts` — current CLI / file paths
- `packages/usrcp-local/src/ledger.ts` — current ledger constructor (probably needs to take a base path)
- `packages/usrcp-local/src/encryption.ts` — key file paths
