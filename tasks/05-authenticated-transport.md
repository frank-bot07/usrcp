# Task 05 — Authenticated MCP transport

**Repo:** `/Users/frankbot/usrcp/packages/usrcp-local/`.

## Context

`docs/SECURITY.md` Section 8 admits:

> stdio transport: MCP communication is unencrypted plaintext over stdio. Any process that can read the pipe sees decrypted data in transit.

This contradicts the security-first brand. The encryption-at-rest story is irrelevant if the data flows out of the process in cleartext over a pipe any local process can read. Close the gap.

## Goal

Add an alternative authenticated transport for the MCP server so the security pitch holds end-to-end.

## What to do

### 1. New transport mode

Add `usrcp serve --transport=http` to `src/index.ts` that runs the MCP server over HTTPS on `127.0.0.1:<port>` using `@modelcontextprotocol/sdk`'s HTTP transport.

### 2. TLS cert generation

- Generate a self-signed TLS cert on first init
- Store at `~/.usrcp/tls/cert.pem` and `~/.usrcp/tls/key.pem`, mode `0600`
- The cert is fine for localhost only; document that we're not pretending to be a public CA
- Re-use the same Node `crypto` primitives already in the project; don't pull in OpenSSL CLI

### 3. Bearer token auth

- Generate a 32-byte random token on init
- Store at `~/.usrcp/auth.token`, mode `0600`
- Emit it once during `init` so the user can configure it in their MCP client
- Compare on every request with `crypto.timingSafeEqual` (reject otherwise with `401`)

### 4. Update `usrcp init` (task 01)

When the new HTTP transport is the default, `init` should register the HTTP transport with the bearer token in the Claude Code config — not stdio.

### 5. Keep stdio mode working

- Gate behind an explicit flag: `usrcp serve --transport=stdio`
- Document the security tradeoff in `SECURITY.md`
- Don't break existing stdio users

### 6. Tests

Add to a new `src/__tests__/transport.test.ts`:
- Cert generation produces valid PEM files with correct permissions
- Bearer rejection on bad/missing token returns `401`
- Bearer accept on good token succeeds
- End-to-end roundtrip: HTTP client calls `usrcp_get_state` and gets back valid JSON
- TLS connection rejected if cert doesn't match (basic sanity)

## Acceptance criteria

- `usrcp serve --transport=http` works with Claude Code
- `curl` without bearer is rejected with `401`
- `curl` with valid bearer can hit `/mcp` endpoint
- `SECURITY.md` updated to retract the stdio-plaintext caveat (now optional, not default)
- All existing tests still green

## Files to read first

- `packages/usrcp-local/src/index.ts` — existing CLI / serve command
- `packages/usrcp-local/src/server.ts` — MCP server setup
- `docs/SECURITY.md` Section 8 — current admission of the gap
- `@modelcontextprotocol/sdk` docs for `StreamableHTTPServerTransport`
