# USRCP in Continue.dev

> **Status:** Config path based on Continue.dev's published MCP support (`~/.continue/config.json` with `mcpServers` key). Not tested against a live Continue install in this project — please file issues if it doesn't work as described.

Continue.dev is an open-source coding assistant with MCP support from v0.9+. It reads MCP servers from `~/.continue/config.json`.

## 1. Install + init

```bash
usrcp init --client=continue
```

This writes (or merges into) `~/.continue/config.json`:

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

If `config.json` already exists with other Continue settings, the `init` command preserves them and only adds the `mcpServers` entry.

## 2. Register with multiple clients

```bash
usrcp init --client=claude,continue
```

Both point at the same local ledger.

## 3. Verify

Reload Continue (VS Code command: "Continue: Reload"). Your USRCP tools should be available to whichever Continue model you're using.

## 4. Troubleshooting

- **Continue doesn't see USRCP tools**: Confirm `~/.continue/config.json` has a top-level `mcpServers` key. If Continue is older than v0.9 it may not support MCP at all — check <https://docs.continue.dev/> for current support.
- **Config file conflicts**: If you maintain Continue config by hand, `usrcp init` may prompt to overwrite. The init command refuses to clobber invalid JSON; fix it or move it aside first.

## References

- Continue MCP docs: <https://docs.continue.dev/customize/deep-dives/mcp>
