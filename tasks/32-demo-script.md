# USRCP demo script (recording-ready)

Date: 2026-06-10 (previously 2026-05-18)
Tested against: `main` @ 8ec9f43 (post PR #100); previously c8c5453

Verified end-to-end on a clean tmp HOME for every flow below except
where called out. Re-verification 2026-06-10, all on macOS / Node 24:

- **Scenario 1** (init → key files 0600 → status → `usrcp_set_fact` /
  `usrcp_get_facts` JSON-RPC round-trip): pass, output matches.
- **Scenario 2** (rotate via `usrcp_rotate_key` → reopen with new
  passphrase → fact survives → auto-snapshot listed): pass. Note:
  `reencrypted` counts timeline events, so it reads `0` when only facts
  exist — the fact still re-encrypts and survives (verified by reading
  it back under the new passphrase).
- **Scenario 3** (pair init on device A → pair join on device B →
  identical `User ID` on both): pass, against the relay running on
  in-process pg-mem via the new `scripts/demo-cloud-pgmem.mjs` — no
  Docker needed (see the no-Docker option below). Docker/Postgres path
  unchanged.
- **`scripts/cross-client-proof.mjs`** (editor A writes / editor B
  reads / raw-SQLite ciphertext scan): pass — "cross-editor claim
  VERIFIED end-to-end".
- **Scenario 4** is an interactive TTY wizard and was not re-verified
  headlessly.

## Demo prerequisites

```bash
# One-time, from repo root:
(cd packages/usrcp-local && npm install && npm run build && npm link)

# Per-recording:
# - Use a tmp HOME so prior demos do not leak state into the next one.
# - Keep terminal width >= 100 cols so QR codes render cleanly.
```

## Scenario 1: First-run setup + agent round-trip (60-90s)

```bash
# A. Fresh init in an isolated HOME so the demo is reproducible.
export DEMO_HOME=$(mktemp -d /tmp/usrcp-demo-XXXXXX)
HOME=$DEMO_HOME usrcp init --passphrase "demo-passphrase"

# Expected output:
#   User slug: default
#   User ID:   u_<16 hex>
#   Keys:      <DEMO_HOME>/.usrcp/users/default/keys/
#   Ledger:    <DEMO_HOME>/.usrcp/users/default/ledger.db
#   Mode:      passphrase-protected
#   MCP:       Registered "usrcp" (stdio) in <DEMO_HOME>/Library/.../claude_desktop_config.json

# B. Show the on-disk layout. Every key file is 0o600.
ls -la $DEMO_HOME/.usrcp/users/default/keys/

# C. Status snapshot.
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase usrcp status
```

For the "agent writes / reads" part of the demo, drive a real agent
(Claude Desktop, Cursor, Claude Code) with the MCP config the init step
just registered. The simplest verbal narration:

> "The agent reads my recent timeline and sees who I am. Now I tell
> it to remember a fact - it calls usrcp_set_fact. I close the
> session, open a fresh one, and the fact is still there."

If you want a non-agent screen capture for the round-trip, the
stdio-mode JSON-RPC dance works too:

```bash
cat > /tmp/demo-mcp.jsonl <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"usrcp_set_fact","arguments":{"domain":"demo","namespace":"intro","key":"hello","value":{"world":true},"caller":"demo-agent"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"usrcp_get_facts","arguments":{"domain":"demo","namespace":"intro","caller":"demo-agent"}}}
EOF
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase usrcp serve --stdio < /tmp/demo-mcp.jsonl
```

## Scenario 2: Master-key rotation (45s)

Demonstrates the new durability work from PRs #71, #72, #73.

```bash
# A. Rotate to a new passphrase. The MCP tool is usrcp_rotate_key.
cat > /tmp/demo-rotate.jsonl <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"usrcp_rotate_key","arguments":{"new_passphrase":"demo-passphrase-v2"}}}
EOF
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase usrcp serve --stdio < /tmp/demo-rotate.jsonl

# Expected response:
#   {"status":"rotated","version":2,"reencrypted":<N>,"skipped":0,
#    "adapter_configs":{"rotated":[...],"absent":[...],"failed":[...]}}

# B. Close + reopen with the NEW passphrase. Identity, facts, timeline
#    all survive. private.pem now decrypts under the new global key
#    (was a latent bug pre PR #73).
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase-v2 usrcp status

# C. Auto-snapshot fires on rotation. List them.
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase-v2 usrcp snapshot --list
```

## Scenario 3: Multi-device pairing (2 min)

Requires a running `usrcp-cloud`. For the demo, the simplest path is
to spin up Postgres + cloud locally via docker compose.

### Prep: stand up the cloud

**No-Docker option (fastest):** the real Fastify app on in-process
pg-mem — same substrate as the usrcp-cloud test suite. Ephemeral by
design; fine for the pairing demo, not for anything persistent:

```bash
(cd packages/usrcp-cloud && npm install && npm run build)
node scripts/demo-cloud-pgmem.mjs &        # listens on 127.0.0.1:19090
```

**Docker + real Postgres** (closer to production):

```bash
# Postgres in a container.
docker run -d --name usrcp-demo-pg \
  -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=usrcp \
  -p 15432:5432 postgres:16-alpine

# Wait for Postgres to be ready, then run the cloud.
(cd packages/usrcp-cloud && npm install && npm run build)
DATABASE_URL=postgres://postgres:demo@127.0.0.1:15432/usrcp \
  PORT=19090 \
  node packages/usrcp-cloud/dist/index.js &
```

### Demo flow

```bash
# Device A (already initialized in Scenario 1).
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase-v2 \
  usrcp config set cloud_endpoint http://127.0.0.1:19090

HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase-v2 usrcp pair init

# Expected output (FRAME THE QR FOR THE CAMERA):
#   Pairing string: NNNN-NNNN-<32 hex chars>
#   Lookup code:    NNNN-NNNN
#   Expires:        <ISO timestamp ~10 min out>
#   <ASCII QR code>
#   On the new device, run:
#     usrcp pair join NNNN-NNNN-<...>

# Device B - fresh HOME.
export DEV_B=$(mktemp -d /tmp/usrcp-demo-B-XXXXXX)
HOME=$DEV_B usrcp pair join <pairing-string-from-A> \
  --passphrase demo-passphrase-v2 \
  --endpoint http://127.0.0.1:19090

# Expected:
#   Joined identity u_<same hex as A>.
#   public_key fingerprint: <truncated>

# Verify identity match:
HOME=$DEV_B USRCP_PASSPHRASE=demo-passphrase-v2 usrcp status | grep "User ID"
# (should match A's User ID)
```

### Cleanup

```bash
docker rm -f usrcp-demo-pg
pkill -f "usrcp-cloud/dist/index.js"
rm -rf $DEMO_HOME $DEV_B
```

## Scenario 4: Capture adapter (claude-code, the only one that works
without live credentials)

```bash
# Adapters live in their own packages and register via the setup wizard.
HOME=$DEMO_HOME USRCP_PASSPHRASE=demo-passphrase-v2 usrcp setup
# - Pick "Use existing default ledger"
# - Pick "claude-code"
# - Allow-list a project path you already have under ~/.claude/projects/
```

After registration the watcher tails JSONLs from that project and pipes
turns into usrcp-stream. The demo narration:

> "Everything I do in Claude Code on this machine becomes searchable
> conversation memory. Each session shows up in usrcp_status as it
> arrives, and the next time any agent opens a session it can recall
> what I said in the previous one."

## What does NOT demo cleanly today

- **OAuth-bearing adapters (Gmail, Google Calendar, GitHub, Linear,
  Discord, Slack, Telegram).** Each setup flow walks through a real
  OAuth or token paste. Possible to record but needs real test
  accounts; do not use real credentials on camera.
- **`usrcp-cloud` via brew or npm.** The cloud is dockerfile + manual
  `npm run build`; not yet packaged for end-user install. Acceptable
  for now (cloud is operator infra, not end-user).
- **Identity rotation (`usrcp rotate-identity`).** Works in tests but
  requires a live cloud round-trip to demonstrate the revocation
  side. Either add to the multi-device demo (rotate after pair) or
  skip.
- **`F_FULLFSYNC` on macOS.** Power-loss durability has a small
  residual window per the PR #71 disclosure. Not a demo concern
  but worth knowing if anyone asks.

## What this script SKIPS to keep recordings short

- `usrcp adapter add/remove` for terminal-agent registration. Useful
  but covered by the `usrcp init` MCP-registration step.
- Scope-restricted servers (`--scopes=...`, `--read-scopes=...`).
  Worth a separate "permissions" demo.
- Sync push / pull. Works but needs realistic data and a running
  cloud; better suited to its own scenario.

## Press-record runbook: the cross-editor screencast

The strategically load-bearing artifact (see `strategy/INTEGRATIONS.md`
§"The demo artifact"): same structured state across two editors, 30s.
Everything below the editor layer is already proven headless by
`scripts/cross-client-proof.mjs` — if that passes on your machine, the
only thing that can fail on camera is an editor's MCP wiring.

```bash
# 0. De-risk: run the headless proof first.
node scripts/cross-client-proof.mjs        # expect "VERIFIED end-to-end"

# 1. Register both editors against your real ledger (NOT a tmp HOME —
#    Claude Desktop and Cursor read their real config paths):
usrcp init --client=claude,cursor          # or `usrcp keychain store` first
#    so neither editor needs USRCP_PASSPHRASE plumbing (see README →
#    Passphrase mode and terminal agents).

# 2. Restart both editors fully (quit, not window-close).
#    Confirm the usrcp tools appear in each editor's MCP tool list.
```

3. **In Claude Desktop**: "I'm a TypeScript founder building USRCP —
   remember that." → agent calls `usrcp_update_identity` /
   `usrcp_append_event`. Show the tool-call confirmation on screen.
4. **In Cursor**: "What languages am I an expert in, and what am I
   working on?" → agent calls `usrcp_get_state`, answers TypeScript +
   USRCP. This is the money shot — keep both editor windows visible.
5. Publish at `docs/demos/cross-editor.mp4` (or a Loom link from
   `docs/demos/cross-editor.md`), then flip the Cursor row to
   `verified` in `docs/INTEGRATIONS/README.md` per the checklist in
   `strategy/INTEGRATIONS.md`.

## If anything breaks on camera

| Symptom | Likely cause | Fix |
|---|---|---|
| `Invalid passphrase` after rotate | env var didn't update | `export USRCP_PASSPHRASE=...` again |
| `pair init` returns `fetch failed` | cloud not running / wrong endpoint | re-check the docker container + `config set cloud_endpoint` |
| `pair join` says "already exists" | device B HOME has a prior identity | use a fresh `mktemp -d` HOME |
| Setup wizard exits cleanly without input | TTY not attached | run in a real terminal, not piped/redirected |
