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

usrcp-stream reuses the cryptographic primitives in `usrcp-local/src/encryption.ts` unchanged: AES-256-GCM with HKDF-derived per-table keys, master key via scrypt(N=131072, r=8, p=2) from the user's passphrase. The stream database (`${USRCP_HOME}/users/<slug>/stream.db`) is column-encrypted at rest.

### What is encrypted on disk

- Event content, channel references, author references, entity references - every TEXT column derived from user input goes through `encryptForColumn` with HKDF domain `stream-events`.
- Thread surfaces, entity references, and summaries - HKDF domain `stream-threads`.
- Active-surface channel references - HKDF domain `stream-surface`.
- The stream config TOML file - HKDF domain `stream-config`.

### What is NOT encrypted on disk

- Embedding vectors (`embeddings.vec`) and thread topic centroids (`threads.topic_centroid`). These are raw float32 BLOBs. sqlite-vec indexes them at the column level and re-encrypting per cosine lookup would defeat the index. An attacker with read access to the database file could embed their own probe strings against the same model and reverse-search the index for similarity hits. Use full-disk encryption (FileVault, dm-crypt) as a second layer if this matters in your threat model.
- Surface names (`events.surface`, `surface_state.surface`), event timestamps, content kinds, and side (inbound/outbound/system). These are metadata used in WHERE clauses and were judged not worth encrypting given they are already exposed via MCP tool calls.

### Keyspace separation from usrcp-local

`usrcp-local`'s domains use HKDF salt `usrcp-domain-<domain>`. `usrcp-stream` calls `deriveDomainEncryptionKey(masterKey, "stream-<table>")` which composes to salt `usrcp-domain-stream-<table>`. No collision is possible between any ledger domain and any stream table key.

### Vendor embedding providers

The default embedding provider is Ollama running on `localhost:11434`. No plaintext ever leaves the machine in this configuration.

Opt-in providers (OpenAI, Voyage AI) require ALL of:

1. The provider must be selected at init (either interactively from the embedding-provider menu, or non-interactively via `--embedding-provider <vendor>`).
2. A confirmation prompt that names the vendor and warns "plaintext leaves your machine. Continue?". Default answer is no.
3. A literal `vendorConsent: true` field in the provider constructor (the init flow injects this only after the prompt is cleared).

The API key is stored inside the encrypted `stream-config.toml`, never on the command line and never in environment variables that might end up in `/proc`.

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

Stream is not a chat backup. It is an in-memory-of-the-agent context layer. The decryption keys live in the process that runs `serve`; there is no central server, and v0.1 ships local-only.

Stream is not a substitute for `usrcp-local`'s blind-index search. They are complementary: structured state for "what is the user's timezone" lives in the ledger; conversational recall for "what did the user say about the retry bug last week" lives in stream.
