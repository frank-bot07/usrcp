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
ciphertext-only — the hosted ledger stores opaque blobs and can never
decrypt.
