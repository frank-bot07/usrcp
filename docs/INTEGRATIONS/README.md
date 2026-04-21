# USRCP Editor Integrations

USRCP works with any MCP-compatible client. Below is the list of editors
with verified config paths (via `usrcp init --client=<name>`) and their
own setup notes.

| Editor | `--client=` value | Status | Setup doc |
|--------|-------------------|--------|-----------|
| Claude Desktop | `claude` (default) | Tested in this repo | [../../README.md](../../README.md) |
| Cursor | `cursor` | Config path only; live testing pending | [cursor.md](cursor.md) |
| Continue.dev | `continue` | Config path only; live testing pending | [continue.md](continue.md) |
| Cline (VS Code) | `cline` | Config path only; live testing pending | [cline.md](cline.md) |

Register with multiple clients at once:

```bash
usrcp init --client=claude,cursor
# or everything:
usrcp init --client=all
```

All clients share the **same** local ledger per user, so structured state
(identity, preferences, projects, timeline events, schemaless facts)
written from any one is readable by the others. Everything is encrypted
at rest under a key the user controls — no editor, and no hosted
service, sees plaintext.
