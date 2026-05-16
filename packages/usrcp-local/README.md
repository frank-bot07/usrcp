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
#  Pairing string: 1234-5678-aabbccdd-eeff0011-22334455-66778899
#  Lookup code:    1234-5678   (use this for 'usrcp pair status' / 'cancel')
#  Expires:        2026-05-16T01:25:00Z

# On the new device:
usrcp pair join 1234-5678-aabbccdd-eeff0011-22334455-66778899 --user=laptop
#  (prompts for the passphrase that protects the existing identity)
```

`pair init` builds a bundle of `master.salt`, `master.verify`,
`identity.json`, and the encrypted `private.pem`, encrypts it under
`HKDF-SHA256(IKM=secret, salt=code, info="usrcp-pairing-v2")`, and
uploads ONLY the 8-digit code + ciphertext to `/v1/pairing/init`. The
16-byte secret half of the pairing string never leaves your devices,
so the cloud cannot decrypt the bundle even if its DB or logs leak.

Share the full pairing string out-of-band: paste between machines via
a trusted channel (clipboard, AirDrop, encrypted DM, QR). Anything
that doesn't traverse the same path as the lookup code is fine.

`pair join` parses the string, fetches the bundle by code, derives the
same key from secret+code, decrypts, writes the four files atomically,
and validates by deriving the master key from the supplied passphrase.
A wrong passphrase rolls back all writes.

```
usrcp pair init    [--ttl=<seconds>] [--endpoint=<url>]
usrcp pair join    <PAIRING-STRING> [--endpoint=<url>] [--force] [--user=<slug>]
usrcp pair status                              # list pending codes (by 8-digit lookup)
usrcp pair cancel  <CODE>                      # delete a pending code (8-digit lookup)
```

The default code TTL is 10 minutes. After 5 wrong claim attempts on a
code the bundle is locked and the source device must re-init. That cap
protects against external attackers probing the public claim endpoint;
they don't have the code OR the secret. The cloud itself does not
have the secret either, so even a compromised cloud cannot decrypt.

See `tasks/12-pair-tier-2.md` for the full v2 design write-up. The
retired v1 design (where the code WAS the scrypt input and the cloud
was trusted for the TTL) is preserved in `tasks/11-multi-device-pairing.md`.
