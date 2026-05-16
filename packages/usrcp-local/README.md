# usrcp-local

Local MCP server for USRCP. Runs as a daemon on your machine and exposes
12 [Model Context Protocol](https://modelcontextprotocol.io) tools for
encrypted persistent memory: identity, preferences, domain context,
timeline events, project workspaces, and per-domain facts.

The on-disk ledger is a single SQLite file (`~/.usrcp/ledger.db`)
encrypted with libsodium secretbox under a master key derived from
`~/.usrcp/master-key`. Every value column is encrypted; only opaque
pseudonyms and HMACs are visible without the key.

## Install and run

```bash
cd packages/usrcp-local
npm install
npm run build
npm start                          # serve over stdio (MCP default)
node dist/index.js setup           # interactive first-run config
node dist/index.js setup --adapter=<name>   # configure a capture adapter
```

`setup` (no `--adapter`) wires the server into your MCP-aware editor /
CLI. Supported targets: `claude-code`, `claude-desktop`, `cursor`,
`windsurf`, `terminal` (recommended), Antigravity, OpenCode, and others.

## MCP tools exposed

| Tool                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `usrcp_get_state`             | Read identity, preferences, and active-domain context     |
| `usrcp_append_event`          | Append a timeline event (encrypted at rest)               |
| `usrcp_update_identity`       | Set name, roles, expertise, communication style           |
| `usrcp_update_preferences`    | Set language, timezone, output format, verbosity, custom  |
| `usrcp_update_domain_context` | Per-domain working state (project, current task, notes)   |
| `usrcp_search_timeline`       | Domain- or channel-scoped recent events                   |
| `usrcp_manage_project`        | Create / list / archive project workspaces                |
| `usrcp_audit_log`             | Surface recent server-side mutations                      |
| `usrcp_rotate_key`            | Rotate the master key in place                            |
| `usrcp_set_fact`              | Write a structured key/value fact for a domain            |
| `usrcp_get_facts`             | Read facts for a domain                                   |
| `usrcp_status`                | Cheap health-check (no decryption)                        |

## Where data lives

```
~/.usrcp/
  master-key            # 32 bytes, mode 0600, never logged
  ledger.db             # encrypted SQLite
  *-config.json         # per-adapter setup output
```

The master key never leaves your machine. Cloud sync (`usrcp-cloud`) is
ciphertext-only - the hosted ledger stores opaque blobs and can never
decrypt.

## Multi-device pairing

Share your identity to a new device without copying `keys/` by hand:

```bash
# On the existing device (passphrase mode required):
usrcp pair init
#  Pairing code:  1234-5678
#  Expires:       2026-05-15T22:50:00Z

# On the new device:
usrcp pair join 1234-5678 --user=laptop
#  (prompts for the passphrase that protects the existing identity)
```

`pair init` builds a bundle of `master.salt`, `master.verify`,
`identity.json`, and the encrypted `private.pem`, encrypts the bundle
under `scrypt(code, FIXED_PAIRING_SALT)`, and uploads the ciphertext to
`/v1/pairing/init`. The server stores the code alongside the
ciphertext, so it is trusted for the 10-minute TTL rather than
cryptographically barred from decrypting (see the trust requirement
below). `pair join` fetches by code, decrypts, writes the four files
atomically, and validates by deriving the master key from the supplied
passphrase. A wrong passphrase rolls back all writes.

```
usrcp pair init    [--ttl=<seconds>] [--endpoint=<url>]
usrcp pair join    <CODE> [--endpoint=<url>] [--force] [--user=<slug>]
usrcp pair status                              # list pending codes
usrcp pair cancel  <CODE>                      # delete a pending code
```

The default code TTL is 10 minutes. After 5 wrong claim attempts on a
code the bundle is locked and the source device must re-init. That cap
protects against external attackers probing the public GET endpoint;
it does NOT protect against the cloud provider itself, which holds the
code alongside the ciphertext during the TTL and can derive the
decryption key in a single scrypt call.

**Trust requirement:** the cloud provider is trusted to not read or
copy the row during the 10-minute pairing window. If that assumption
doesn't hold for your provider, copy `keys/` between devices manually
(SSH/USB) instead. The full design and the tier-2 redesign options
(out-of-band secret, hashed lookup key) live in
`tasks/11-multi-device-pairing.md`.
