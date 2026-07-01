# usrcp-core

**The framework-agnostic core of [USRCP](https://github.com/frank-bot07/usrcp) — the encrypted ledger, crypto, device pairing, identity rotation, and scope enforcement, with no MCP server and no CLI.**

`usrcp-core` is the protocol engine every other USRCP package builds on. It has
no opinion about how it's driven — the local MCP server (`usrcp-local`), the
capture adapters, and `usrcp-stream` all depend on it for the same encrypted,
structured user state. Its only runtime dependencies are `better-sqlite3` and
`zod`.

If you just want to run USRCP, install [`usrcp`](https://www.npmjs.com/package/usrcp)
(`npm i -g usrcp`) or `brew install frank-bot07/usrcp/usrcp` — you don't install
`usrcp-core` directly. This package is for building on the protocol.

## What's in it

- **Encrypted ledger** (`usrcp-core/ledger`) — a single SQLite file where every
  value is encrypted at rest (libsodium secretbox) under a master key that never
  leaves the machine. Structured facts, timeline events, domain context, audit log.
- **Encryption + crypto** (`usrcp-core/encryption`, `usrcp-core/crypto`) —
  master-key derivation, per-domain keys, HMAC blind-index search tokens,
  identity keypair management.
- **Device pairing** (`usrcp-core/pair`) — the pairing protocol (the terminal QR
  rendering lives in `usrcp-local`, not here).
- **Identity rotation** (`usrcp-core/rotate-identity`).
- **Scope enforcement** (`usrcp-core/scope-enforcement`) — default-deny read
  projections and per-tool scoping, shared so `usrcp-local` and `usrcp-stream`
  enforce identical semantics.

## Install

```bash
npm install usrcp-core
```

`better-sqlite3` is a native module; it builds on install.

## Subpath exports

```ts
import { Ledger } from "usrcp-core/ledger";
import { encrypt, decrypt, deriveDomainEncryptionKey } from "usrcp-core/encryption";
import { getIdentity } from "usrcp-core/crypto";
import { pairInit, pairJoin } from "usrcp-core/pair";
import { rotateIdentity } from "usrcp-core/rotate-identity";
import { registerToolsWithScopes } from "usrcp-core/scope-enforcement";
```

The barrel (`usrcp-core`) re-exports all of the above.

## What it is not

- **Not the MCP server.** That's `usrcp-local` (which depends on this).
- **Not a CLI.** No `usrcp` command here — that's `usrcp-local`.
- **Not a semantic memory layer.** USRCP stores structured, exact-match user
  state; it does not do vector/embedding recall. See the
  [main README](https://github.com/frank-bot07/usrcp#what-usrcp-is-vs-isnt).

## License

Apache-2.0
