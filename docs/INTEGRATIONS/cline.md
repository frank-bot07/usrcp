# USRCP in Cline

> **Status:** Config path based on Cline's published MCP docs (VS Code global storage under `saoudrizwan.claude-dev`). Not tested against a live Cline install in this project.

Cline is the VS Code extension at `saoudrizwan.claude-dev`. It reads MCP servers from:

- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

## 1. Init

```bash
usrcp init --client=cline
```

`init` creates the parent directories if missing and writes the `mcpServers` entry.

## 2. Register with multiple clients

```bash
usrcp init --client=all
```

## 3. Caveats

- If you use VS Code Insiders or Cursor (which forks VS Code), the globalStorage path may differ. `usrcp init --client=cline` targets stock VS Code; edit the written file to point at your install if needed.
- Cline must be restarted (VS Code reload) to pick up new MCP servers.

## References

- Cline MCP docs: <https://docs.cline.bot/mcp-servers/configuring-mcp-servers>
