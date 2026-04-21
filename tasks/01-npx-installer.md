# Task 01 — `npx usrcp init` one-liner installer

**Repo:** `/Users/frankbot/usrcp` — work primarily in `packages/usrcp-local/`.

## Goal

Reduce installation from a 5-step gauntlet (clone → npm install → build → init → manual MCP server registration) to a single command:

```bash
npx usrcp init
```

## What to do

- Add a `bin` entry in `packages/usrcp-local/package.json` exposing the CLI as `usrcp` so npx can resolve it from the npm registry.
- The `init` command should:
  1. Create `~/.usrcp/` if missing
  2. Prompt for passphrase mode vs dev mode (default: passphrase)
  3. Derive and store the salt/verify files
  4. Auto-detect Claude Code's MCP config location:
     - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
     - Linux: `~/.config/Claude/claude_desktop_config.json`
     - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  5. Append the USRCP MCP server entry
  6. Print next steps including how to start the server and how to set the `USRCP_PASSPHRASE` env var
- Detect if USRCP is already registered in the MCP config and skip with a friendly message rather than duplicating.
- Publish the `usrcp` package to npm so `npx usrcp` resolves. Confirm the package name is available first; fall back to `@usrcp/cli` if not.

## Out of scope

- Don't ship the hosted ledger client; this is local-only.
- Don't change the encryption code.

## Acceptance criteria

A clean machine running `npx usrcp init` (with no prior install) ends up with a registered MCP server visible in Claude Code after restart, asking the user nothing more than "passphrase?".

## Files to read first

- `packages/usrcp-local/src/index.ts` (current CLI)
- `packages/usrcp-local/package.json`
- `README.md` (for current install instructions)
