# Demo runbook — multi-app, fresh machine

**Goal:** show, on a clean machine as a brand-new user, that structured user
state typed **once** flows across **three different applications** (GUI chat →
IDE → terminal) — and that it's encrypted on the user's own disk. Target
runtime: **90–120s**.

**Why a fresh machine.** Zero data from your daily box means nothing to hide
behind: if an adapter is broken or a tool doesn't fire, the demo exposes it.
Treat the **first cold run as the test, the second as the take.** Do a full
silent dry-run, fix what falls over, *then* record. The rehearsal gate below
(`preflight.sh` + `cross-client-proof.mjs`) is designed to catch breakage off
camera.

---

## Cast

| Role in demo | App | Why it's in the lineup |
|---|---|---|
| Seed (write) | **Claude Desktop** | Most recognizable; natural-conversation capture |
| Payoff (read) | **Cursor** | Visually distinct IDE — the "it just knew" moment |
| Proof it's a protocol | **Claude Code** (terminal) | Different modality entirely, same state |
| Trust beat | Terminal (`sqlite3`) | Raw ledger is ciphertext; the key never left the machine |

**Persona — keep it specific so the payoff is concrete.** Vivid facts make
"it just knew" land:

> **Dana** — TypeScript dev in **Austin** (timezone), building **"Harbor"**, a
> **Next.js** app, uses **pnpm**, deploys on **Vercel**, hates emoji in commit
> messages.

These become the canaries you look for downstream: `Harbor`, `Austin`, `pnpm`.

---

## Part 0 — Fresh machine prep (off camera)

1. A clean macOS user account (or a fresh VM) with **no** prior `~/.usrcp`,
   Homebrew present, and the three apps installed but **not** yet configured
   for USRCP.
2. Sign the three apps into whatever accounts they need. Get their default
   "empty" state ready so Beat 0 (the cold shrug) is real.
3. Have a terminal open for the install + trust beats.

---

## Part 1 — Install + register (this becomes Beat 1)

```bash
# 1. Install (node comes in as a dependency)
brew install frank-bot07/usrcp/usrcp
usrcp --help          # confirm the banner reads v0.2.2

# 2. Initialize in passphrase mode and register the two GUI/IDE clients.
#    You'll be prompted for a passphrase; say YES to the keychain offer so no
#    plaintext passphrase ends up in any app config (important on camera).
usrcp init --client=claude,cursor

# 3. Register the terminal agent (Claude Code) — terminal agents use a
#    separate adapter, not --client.
usrcp adapter add terminal --targets=claude-code

# 4. (Optional) confirm the passphrase is in the keychain, not on disk
usrcp keychain status
```

**Restart each app** after registration so it re-reads its MCP config. Claude
Desktop and Cursor both pick up the `usrcp` server on relaunch.

Config files written (spot-check them if a beat won't fire):
- Claude Desktop — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Cursor — `~/.cursor/mcp.json`

---

## Part 2 — The rehearsal gate (run BEFORE you record)

**Do not record until both of these are green.**

```bash
# A. Machine + registration checks (version, configs, keychain, ciphertext).
#    Run from anywhere; it inspects your real ~/.usrcp and app configs.
bash scripts/preflight.sh

# B. The headless end-to-end proof — writes as "Claude Desktop", reads back as
#    a fresh "Cursor" process, then asserts the raw ledger is ciphertext.
#    Runs against an isolated HOME, so it never touches your demo ledger.
#    Requires the repo cloned + built (npm run build in packages/usrcp-local).
node scripts/cross-client-proof.mjs
echo "exit=$?"   # 0 = the cross-tool claim holds end-to-end
```

If `cross-client-proof.mjs` exits 0, **USRCP itself works** — the only thing
left that can break on camera is an individual app's MCP wiring, which is
exactly what the live rehearsal (Part 3) surfaces.

---

## Part 3 — The recorded beats

> The illusion depends on the agents calling the MCP tools **on their own**.
> The write tools are `usrcp_update_identity` / `usrcp_manage_project` /
> `usrcp_set_fact`; the read tool is `usrcp_get_state`. See the failure
> playbook if a beat doesn't fire.

**Beat 0 — The problem (10s).** In Claude Desktop *and* Cursor, ask the same
thing: *"What's my stack and what am I working on?"* Both give generic /
empty answers. Caption: **"Every tool starts from zero."**

**Beat 1 — One install (15s).** Screen-capture the Part 1 commands (speed-ramp
the brew install). Caption: **"One install. One passphrase. Every tool."**

**Beat 2 — Seed once, naturally, in Claude Desktop (25s).** Dana just talks:

> *"I'm kicking off a new project called Harbor — Next.js, pnpm, deploying on
> Vercel. I'm based in Austin. And please, no emoji in my commit messages."*

Watch for the agent to call `usrcp_update_identity` / `usrcp_manage_project` /
`usrcp_set_fact`. Point: she typed it **once**, in normal conversation.

**Beat 3 — The payoff in Cursor (25s).** Switch to Cursor. Fresh chat, **give
it no context**:

> *"Set up my usual project structure and write me a quick standup."*

The agent calls `usrcp_get_state`, then scaffolds a pnpm + Next.js layout and
a standup that references **Harbor** and **Austin**. Caption: **"Never told
Cursor anything. It just knew."** ← the money shot.

**Beat 4 — Not a two-app trick (20s).** Drop to a terminal with Claude Code:

> *"What am I working on, and what are my tooling preferences?"*

Same state, different modality. Caption: **"It's a protocol, not an
integration."**

**Beat 5 — And it's YOURS (20s).** In the terminal:

```bash
# The meaningful fields are ciphertext; only structural columns are readable.
sqlite3 ~/.usrcp/users/default/ledger.db \
  "select event_id, substr(summary,1,32) from timeline_events limit 3;"
# → event_id is a plain ULID; summary is 'enc:...' — unreadable at rest.

sqlite3 ~/.usrcp/users/default/ledger.db "select * from core_identity;"
# → every human field is 'enc:...'
```

Caption: **"Encrypted on your machine. The key never left it. No vendor sees a
thing."** ← the differentiator vs Mem0 / vendor memory.

**Beat 6 — Close (5s).** Tagline + `brew install frank-bot07/usrcp/usrcp` on
screen.

---

## Failure playbook

**The #1 risk: an agent doesn't call the tool.** MCP tools are *available*, but
the model decides whether to use them. If Beat 2 doesn't write or Beat 3
doesn't read on its own:

- First, find out **which** beats need help during rehearsal — not live.
- Acceptable honest cue that still proves cross-tool: end the prompt with
  *"…using what you already know about me."* You're nudging the agent to
  consult its memory, not feeding it the answer. The state still crossed apps.
- If a GUI app never unlocks the ledger, it's almost always the passphrase:
  confirm `usrcp keychain status` shows a stored entry, and that the app was
  restarted after `usrcp init`.

**A beat crashes / server won't start.** Re-run `bash scripts/preflight.sh`; a
red check tells you which of version / config / keychain / ciphertext failed.

**Nothing reads back across apps but `cross-client-proof.mjs` passed.** Then
USRCP is fine and it's the specific app's MCP wiring — check that app's config
path (Part 1) and restart it.

---

## Command reference (all real, verified against v0.2.2)

| Purpose | Command |
|---|---|
| Install | `brew install frank-bot07/usrcp/usrcp` |
| Init + register GUI/IDE clients | `usrcp init --client=claude,cursor` |
| Register a terminal agent | `usrcp adapter add terminal --targets=claude-code` |
| Keychain status / store | `usrcp keychain status` · `usrcp keychain store` |
| Inspect ciphertext at rest | `sqlite3 ~/.usrcp/users/default/ledger.db "select * from core_identity;"` |
| Headless cross-tool proof | `node scripts/cross-client-proof.mjs` |
| Machine pre-flight | `bash scripts/preflight.sh` |

Related: [`cross-editor.md`](cross-editor.md) (the two-app written walkthrough),
`../../scripts/cross-client-proof.mjs`, `../../tasks/32-demo-script.md`.
