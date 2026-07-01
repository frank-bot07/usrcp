# usrcp-stream

Cross-surface conversation layer for USRCP. Encrypted local capture of every conversational event the user touches, semantic recall across surfaces, thread stitching, active-surface presence, and pre-warm broadcast.

usrcp-stream is a sibling package to `usrcp-local`. The ledger handles structured user state (identity, preferences, projects, timeline events). Stream handles conversational events with semantic recall.

## What stream adds over usrcp-local

1. **Bidirectional capture.** Both sides of every channel, not just what the user authored. The inbound message is usually the load-bearing context.
2. **Local vector layer.** Embeddings indexed under the same passphrase as the ledger. No vendor calls by default.
3. **Cross-channel thread stitching.** A Discord thread that continues in iMessage three hours later gets one logical `thread_id`.
4. **Active-surface presence.** Which surface the user is on right now, with last-seen timestamps.
5. **Pre-warm broadcast.** When the user pivots between surfaces, the new surface's agent gets a summary of the prior surface in its first turn.

## Quickstart

```bash
# 1. Build everything (assumes you cloned the monorepo)
cd packages/usrcp-local && npm install && npm run build
cd ../usrcp-stream && npm install && npm run build

# 2. Configure the embedding provider (default: local Ollama)
ollama serve &
ollama pull nomic-embed-text
node dist/index.js init

# 3. Run the standalone MCP server
node dist/index.js serve
```

Configure your MCP client to spawn `usrcp-stream serve` over stdio. The six tools it exposes:

| Tool | Purpose |
|---|---|
| `stream_capture` | Write one event from any surface |
| `stream_recall` | Semantic search across surfaces |
| `stream_thread` | Fetch all events in a logical thread |
| `stream_active_surface` | Where the user is right now |
| `stream_prewarm` | Cross-surface handoff summary |
| `stream_status` | Counts and embedding config |

## Unified mode (alongside usrcp-local)

When `usrcp-local` is also installed, running `usrcp serve` will automatically pick up `usrcp-stream`'s tools via a lazy require. Both packages share one master key derived once from the user's passphrase. Switching between unified mode (`usrcp serve`) and standalone mode (`usrcp-stream serve`) does not require re-encrypting any data; the same key derives identically either way (see `master-key-stability.test.ts`).

## Threat model

usrcp-stream reuses the cryptographic primitives in `usrcp-core/src/encryption.ts` unchanged: AES-256-GCM with HKDF-derived per-table keys, master key via scrypt(N=131072, r=8, p=2) from the user's passphrase. The stream database (`${USRCP_HOME}/users/<slug>/stream.db`) is column-encrypted at rest.

### What is encrypted on disk

- Event content, channel references, author references, entity references - every TEXT column derived from user input goes through `encryptForColumn` with HKDF domain `stream-events`.
- Thread surfaces, entity references, and summaries - HKDF domain `stream-threads`.
- Active-surface channel references - HKDF domain `stream-surface`.
- The stream config TOML file - HKDF domain `stream-config`.

### What is NOT encrypted on disk

- Embedding vectors (`embeddings.vec`) and thread topic centroids (`threads.topic_centroid`). These are raw float32 BLOBs. sqlite-vec indexes them at the column level and re-encrypting per cosine lookup would defeat the index. An attacker with read access to the database file could embed their own probe strings against the same model and reverse-search the index for similarity hits. Use full-disk encryption (FileVault, dm-crypt) as a second layer if this matters in your threat model.
- Surface names (`events.surface`, `surface_state.surface`), event timestamps, content kinds, and side (inbound/outbound/system). These are metadata used in WHERE clauses and were judged not worth encrypting given they are already exposed via MCP tool calls.

### Keyspace separation from usrcp-core

`usrcp-core`'s domains use HKDF salt `usrcp-domain-<domain>`. `usrcp-stream` calls `deriveDomainEncryptionKey(masterKey, "stream-<table>")` which composes to salt `usrcp-domain-stream-<table>`. No collision is possible between any ledger domain and any stream table key.

### Vendor embedding providers

The default embedding provider is Ollama running on `localhost:11434`. No plaintext ever leaves the machine in this configuration.

Opt-in providers (OpenAI, Voyage AI) require ALL of:

1. The provider must be selected at init (either interactively from the embedding-provider menu, or non-interactively via `--embedding-provider <vendor>`).
2. A confirmation prompt that names the vendor and warns "plaintext leaves your machine. Continue?". Default answer is no.
3. A literal `vendorConsent: true` field in the provider constructor (the init flow injects this only after the prompt is cleared).

The API key is stored inside the encrypted `stream-config.toml`, never on the command line and never in environment variables that might end up in `/proc`.

## Cloud sync

Stream supports zero-knowledge cross-device sync via the existing `usrcp-cloud` server (Fastify + Postgres). Two new routes were added in PR #44:

- `POST /v1/stream/push` — accepts encrypted events + encrypted embeddings, assigns a per-user monotonic `server_seq`.
- `GET /v1/stream/pull?since=N` — returns events with `server_seq > N` in monotonic order.

Both reuse the existing Ed25519 per-request signature auth used by ledger sync. The server stores ciphertext only; nothing decrypts server-side.

### What syncs

| Item | Synced? | Notes |
|---|---|---|
| `events` | **Yes** | Encrypted columns (channel_ref, author_ref, content, entity_refs) ride through verbatim under the existing `stream-events` HKDF domain. Surface, side, content_kind, ts_ms stay plaintext for cursor / index purposes. |
| `embeddings` | **Yes, encrypted** | Raw float32 vectors are re-encrypted client-side under a new HKDF domain `stream-embeddings` before push. Server stores opaque `vec_enc` blobs and the model name (also encrypted). Receiving device decrypts and inserts raw into the local `sqlite-vec` index. |
| `threads` | **No** | Threads are derived state. The receiving device re-runs the stitcher over pulled events to rebuild local thread linkage. Thread IDs may differ across devices but content is identical. |
| `surface_state` | **No** | Active-surface is per-device by design. |
| `stream-config.toml` | **No** | Each device opts in to its own embedding provider. |

### Triggering sync

```bash
# CLI
usrcp-stream sync push   --endpoint=https://your.cloud.url
usrcp-stream sync pull   --endpoint=https://your.cloud.url
usrcp-stream sync status
```

Or via MCP, when the server is launched with `cloudEndpoint`:

- `stream_sync_push` — global-mutation, rejected when the MCP server runs with `--scopes`
- `stream_sync_pull` — global-mutation, same rejection rule
- `stream_sync_status` — global-read, always available

The CLI subcommand and the MCP tool both call the same `syncStreamPush` / `syncStreamPull` / `syncStreamStatus` functions in `src/sync.ts`. Cursors (`last_pushed_local_id`, `last_pulled_server_seq`, `last_sync_at`) live in a small `sync_state` table inside `stream.db`.

### Multi-device key model

The receiving device decrypts pulled events using its local `stream-events` key. Two devices with the same passphrase produce identical HKDF-derived domain keys (verified by `master-key-stability.test.ts`'s frozen vectors). The Ed25519 identity used for cloud auth must be shared across devices (today: copy the `keys/` dir during pairing).

### What's NOT in scope yet

- Three-way device conflict resolution beyond LWW (the stitcher re-runs on each device, so order-of-pull divergence is handled naturally for thread state).
- WebSocket / push-style sync. Pull is polling; run on a cron or via an agent loop.
- Backfilling pre-PR-#41 events into the server.
- Rate limiting on the new endpoints.

## Capture surface coverage

| Surface | Package | Notes |
|---|---|---|
| Discord | `usrcp-discord` | `--mode both` default; ledger user-only, stream both sides |
| Telegram | `usrcp-telegram` | `--mode both` default |
| iMessage | `usrcp-imessage` | `--mode both` default; no bot filter (iMessage has none) |
| Slack | `usrcp-slack` | `--mode both` default; DMs respect channel allowlist |
| Claude Code CLI | `usrcp-claude-code` | Stream-only (no ledger destination for turn content); per-project allowlist; tails `~/.claude/projects/<dir>/*.jsonl` |
| Claude Desktop (GUI) | - | Deferred. Transcripts in LevelDB binary blobs under `IndexedDB/`; plaintext JSON is metadata only. Real capture needs LevelDB extraction + reverse-engineering Anthropic's schema. |
| Cursor | - | Deferred indefinitely. Chats live in `state.vscdb` (SQLite, undocumented schema); brittle, low value on observed machines. |
| VS Code | - | Deferred. `usrcp-vscode` is read-only; needs an event-emit hook in the extension before capture is possible. |

## Configuration

Defaults match the build prompt §7 and §8 thresholds:

- `entity_window_ms`: 24h (entity-overlap candidacy)
- `topic_threshold`: 0.78 (cosine cutoff)
- `topic_window_ms`: 6h (topic-similarity candidacy)
- `same_channel_window_ms`: 30m (same-surface continuation)
- `link_threshold`: 0.55 (composite score required to link)
- `active_window_ms`: 10m (active-surface freshness)

Overrides go in `stream-config.toml` and are merged at runtime.

## What stream is not

Stream is not a chat backup. It is an in-memory-of-the-agent context layer. The decryption keys live in the process that runs `serve`; there is no central server, and v0.2 ships local-only.

Stream is not a substitute for `usrcp-local`'s blind-index search. They are complementary: structured state for "what is the user's timezone" lives in the ledger; conversational recall for "what did the user say about the retry bug last week" lives in stream.
