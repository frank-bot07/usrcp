# Quickstart — legacy prototype

> This file belonged to `usrcp-sdk v0.3.0`, a January-February 2026
> prototype. It does **not** describe the current USRCP protocol or
> reference implementation. See [`README.md`](./README.md) in this
> directory for context, and [`/packages/usrcp-local/`](../packages/usrcp-local)
> for the real MCP server.

## Current install, not this

```bash
# The current reference implementation is usrcp-local (an MCP server),
# not usrcp-sdk. Install the CLI via Homebrew:

brew install frank-bot07/usrcp/usrcp

usrcp init --client=claude,cursor

# Capture adapters still require a source build:
#   git clone https://github.com/frank-bot07/usrcp.git
#   cd usrcp/packages/usrcp-local && npm install && npm run build && npm link
```

See the repo root [`README.md`](../README.md) for the full quickstart,
per-client integration docs, and the security model.

## Why this file is not deleted

Kept alongside `./README.md` so anyone landing from an npm link to
`usrcp-sdk v0.3.0` can figure out what happened without a 404.
