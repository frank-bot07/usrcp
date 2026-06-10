# usrcp

**User Context Protocol — structured, encrypted, cross-platform memory for AI agents.**

This is the umbrella package for [USRCP](https://github.com/frank-bot07/usrcp). Installing it gives you the `usrcp` CLI and encrypted local ledger (it depends on [`usrcp-local`](https://www.npmjs.com/package/usrcp-local)).

```bash
npm install -g usrcp
usrcp init
usrcp serve
```

USRCP keeps an encrypted, ledger-style store of your identity, preferences, projects, and interaction timeline, and exposes it to any MCP-compatible agent (Claude Desktop, Cursor, Continue, Cline, …) — so your structured state follows you across tools, with all data encrypted at rest under a key you control.

## Capture adapters

The base install is the CLI + ledger. To capture activity from other sources, add an adapter:

```bash
usrcp setup --adapter=linear      # or: github, gmail, slack, discord, telegram, obsidian, …
```

See the [full adapter list and docs](https://github.com/frank-bot07/usrcp#capture-adapters).

## License

Apache-2.0
