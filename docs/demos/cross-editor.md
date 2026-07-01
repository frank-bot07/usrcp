# Demo: the same user state across two editors (server holds only ciphertext)

This is the recording script for the pitch's central artifact — **write
structured user state in one editor, read it in another, while the on-disk
ledger stays ciphertext.** It's the thing `strategy/INTEGRATIONS.md` flags as
"aspirational until this exists."

## Division of labor

- **The mechanism is already verified headlessly.** `scripts/cross-client-proof.mjs`
  reproduces the exact claim with two MCP sessions against one ledger + a raw-DB
  ciphertext scan — no editors involved. Run it first; if it's green, the only
  thing that can break on camera is an editor's own MCP wiring, not USRCP.
- **The on-camera part is yours** (Chad): two real editor installs, screen
  recording. This doc is the shot list + narration.

```bash
# Pre-flight: prove the claim holds before recording anything.
(cd packages/usrcp-core && npm run build) && (cd packages/usrcp-local && npm run build)
node scripts/cross-client-proof.mjs      # expect: "cross-editor claim VERIFIED end-to-end"
```

## What the audience needs to believe

1. Editor A (Claude Desktop) learns who you are and writes it to USRCP.
2. Editor B (Cursor) — a *different app* — answers questions about you using
   that state, having been told nothing in this session.
3. The data on disk is encrypted; even with the SQLite file, an attacker sees
   only ciphertext.

Keep it to ~60–90s. Three beats, one payoff (the raw-DB reveal).

## Setup (before recording)

Use a throwaway ledger so nothing personal shows on screen. **Passphrase mode**
is the right choice for the demo — it's what makes the "key never on disk"
point land.

```bash
# Fresh ledger + register BOTH editors in one shot.
export USRCP_PASSPHRASE="demo-pass-do-not-reuse"
usrcp init --passphrase "$USRCP_PASSPHRASE" --client=claude,cursor
```

`--client=claude,cursor` writes the `usrcp` MCP server entry into both
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`

> **GUI apps don't inherit your shell env.** Claude Desktop and Cursor are
> launched from the Dock, so they won't see `USRCP_PASSPHRASE` from `.zshrc`.
> Either add an `env` block to each server entry (see the README "Passphrase
> mode and terminal agents" section) or run `launchctl setenv USRCP_PASSPHRASE
> "demo-pass-do-not-reuse"` before launching them. Verify the USRCP tools
> actually appear in each editor before you hit record.

Restart both editors so they pick up the new MCP server.

## Shot list

### Beat 1 — Editor A (Claude Desktop) writes state  (~20s)

Type to Claude Desktop:

> "I'm a founder and a TypeScript expert. I'm working on a project called Helios
> — an encrypted cross-editor memory protocol. Save that to my USRCP memory."

It should call `usrcp_update_identity`, `usrcp_manage_project`, and probably
`usrcp_append_event`. Let the tool calls show on screen — that's the "it's
writing structured state" beat. **Do not mention USRCP's internals; talk like a user.**

### Beat 2 — Editor B (Cursor) reads it back  (~20s)

Switch to Cursor (a brand-new chat). Type:

> "Using my USRCP memory, what am I an expert in and what am I building?"

It should call `usrcp_get_state` and answer "TypeScript" + "Helios, an encrypted
cross-editor memory protocol" — **without you having told Cursor anything this
session.** That's the payoff: two different apps, one shared brain.

### Beat 3 — The ciphertext reveal  (~25s)

In a terminal, open the raw ledger and show there's no plaintext:

```bash
# The DB an attacker would steal:
sqlite3 ~/.usrcp/users/default/ledger.db \
  "SELECT summary, intent, domain FROM timeline_events LIMIT 3;"
# → enc:…  enc:…  d_<hmac-pseudonym>   (no readable text, domains are HMACs)

# Prove it the blunt way — grep the whole file for what you typed:
grep -c "Helios" ~/.usrcp/users/default/ledger.db   # → 0
grep -c "TypeScript" ~/.usrcp/users/default/ledger.db # → 0
```

Narration: *"The state lived on my machine, encrypted under a key derived from
my passphrase — which is never written to disk. The editors read plaintext;
the file on disk, and any synced copy, is ciphertext."*

> **Truth-in-advertising note for the script:** one field is plaintext by
> design — a project's `project_id` (the opaque slug you choose, used as the
> upsert key). The project's *name*, *summary*, and all event content are
> encrypted. If you want a zero-asterisk reveal, grep for the project **name**
> ("Helios"), not an id you set. Don't claim "every byte is encrypted" — claim
> "all your content is encrypted," which is what the raw scan actually shows.

## After recording

- Save to `docs/demos/cross-editor.mp4` (or a Loom link in this file).
- Flip the relevant `strategy/INTEGRATIONS.md` rows from `config-written` →
  `verified` and note the demo link.
- Only then is the "same state across two editors" line in the pitch backed by
  a real artifact.

## If an editor misbehaves on camera

Fall back to the headless proof as the artifact — it demonstrates the identical
claim and always works:

```bash
node scripts/cross-client-proof.mjs
```

Record that running green (two MCP sessions = two editors; the raw-DB scan = the
ciphertext reveal). Less flashy than two real IDEs, but it's honest and
reproducible, and it makes the same point.
