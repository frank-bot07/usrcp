# USRCP for VS Code

Browse your encrypted USRCP memory ledger from inside VS Code.

This is the v0.1 read-only client. It adds a **USRCP** activity-bar item with a
**Facts** tree (grouped by domain), a status-bar indicator, and three commands:

- `USRCP: Refresh` — re-fetch domains and facts
- `USRCP: Show Status` — events / projects / domains summary
- `USRCP: Open Ledger Directory` — reveal `~/.usrcp` in your file manager

The extension talks to your local ledger by spawning
`usrcp serve --transport=stdio`. No network calls. No data leaves the box.

## Requirements

The `usrcp` CLI must be installed. The simplest path:

```sh
brew install frank-bot07/usrcp/usrcp
```

If `usrcp` isn't on your `PATH`, set the absolute path in VS Code settings
(`usrcp.binaryPath`).

## Sideload (development)

Until v0.2 publishes to the Marketplace, install the `.vsix` directly:

```sh
cd packages/usrcp-vscode
npm install
npm run build
npm run package         # produces usrcp-vscode-0.1.0.vsix
code --install-extension usrcp-vscode-0.1.0.vsix
```

Reload VS Code, click the USRCP icon in the activity bar.

## Read-only by design

Write tools (`set_fact`, `append_event`, etc.) are **not** exposed in the UI.
The long-term direction is humans-read / agents-write — agents transact
against the ledger autonomously, humans browse it.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `usrcp.binaryPath` | _(empty)_ | Override the binary path. If empty, searches `$PATH`, `/opt/homebrew/bin/usrcp`, `/usr/local/bin/usrcp`. |
| `usrcp.user` | _(empty)_ | User slug to load (matches `usrcp users` output). Empty = default user. |

## License

Apache-2.0
