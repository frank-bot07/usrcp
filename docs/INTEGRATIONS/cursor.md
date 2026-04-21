# USRCP in Cursor

> **Status:** Config path verified against Cursor's public docs (MCP global config at `~/.cursor/mcp.json`). End-to-end testing against a live Cursor install has **not** been done in this project yet — if you hit a Cursor-specific issue, please file it.

## 1. Install USRCP

If you haven't already:

```bash
cd packages/usrcp-local && npm install && npm run build && npm link
```

(`npx usrcp` will work once published — see the root README.)

## 2. Initialize for Cursor

```bash
usrcp init --client=cursor
```

This writes to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "usrcp": {
      "command": "node",
      "args": ["/path/to/dist/index.js", "serve", "--transport=stdio", "--user=default"]
    }
  }
}
```

If you already use Cursor with other MCP servers, the `init` command **merges** into the existing `mcpServers` object rather than overwriting it.

## 3. Register with both Claude Desktop and Cursor at once

```bash
usrcp init --client=claude,cursor
```

or

```bash
usrcp init --client=all
```

Both clients read the **same** local ledger. Writing an event from Cursor makes it visible to Claude Desktop (and vice versa) as soon as `usrcp_get_state` is called.

## 4. Verify

Restart Cursor after running `init`. Open a chat and the AI should have access to tools prefixed with `usrcp_` (`usrcp_get_state`, `usrcp_append_event`, etc.).

Quick smoke test:

> **You:** "Use USRCP to check my stored identity."

The AI should call `usrcp_get_state` and return (at minimum) `display_name`, `roles`, `expertise_domains`, `global_preferences`.

## 5. Multi-user on one machine

If you run multiple ledgers (`usrcp init --user=frank` and `usrcp init --user=jess`), each registers a separate entry in Cursor's config:

```json
{
  "mcpServers": {
    "usrcp-frank": { "command": "node", "args": [..., "--user=frank"] },
    "usrcp-jess":  { "command": "node", "args": [..., "--user=jess"]  }
  }
}
```

Cursor shows both as available MCP servers; the agent decides which to call based on context.

## 6. HTTPS + bearer transport (advanced)

If you'd rather not auto-spawn a stdio child, run USRCP as a standalone HTTPS server:

```bash
usrcp init --client=cursor --transport=http --port=9876
usrcp serve --transport=http --port=9876
```

Cursor's MCP config receives a `{ type: "http", url, headers: { Authorization: ... } }` entry. The bearer token and TLS cert live at `~/.usrcp/users/<slug>/auth.token` and `~/.usrcp/users/<slug>/tls/`. See [`docs/SECURITY.md` §9](../SECURITY.md) for the threat model.

Known caveat: Cursor needs to trust the self-signed localhost cert. If Cursor refuses, pin the cert via your system trust store or fall back to stdio.

## 7. Troubleshooting

- **"MCP server failed to start"**: Check that `node /path/to/dist/index.js serve --user=<slug>` runs by hand. If it errors about a missing passphrase, either provide `USRCP_PASSPHRASE` via your shell profile or re-init in dev mode (`usrcp init --dev`).
- **Tools don't appear**: Fully quit and relaunch Cursor. MCP servers are loaded at startup.
- **Want to unregister**: Open `~/.cursor/mcp.json` and delete the `usrcp` (or `usrcp-<slug>`) entry.

## References

- Cursor MCP docs: <https://docs.cursor.com/context/model-context-protocol>
- USRCP security model: [../SECURITY.md](../SECURITY.md)
