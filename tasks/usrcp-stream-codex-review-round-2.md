# Codex Review Round 2 - feat/usrcp-stream (commit 439f2d9)

## Verdict
REJECT

## P0 Findings (blocking)
- P0 - packages/usrcp-stream/src/tools/stream-thread.ts:81
  `stream_thread` still leaks out-of-scope thread metadata in scoped mode. The fix filters `events` by allowed surface and narrows the returned `surfaces`, but it still loads the thread row by `thread_id` without a scope gate and returns `status: "ok"`, `first_ts_ms`, `last_ts_ms`, and decrypted `entity_refs` even when every event in the thread is out of scope. I proved this with a node script against `dist/register.js`: after seeding a telegram-only thread with `entity_refs: ["SECRET_PROJECT_ID"]`, a server launched with `serveOptions: { scopes: ["discord"] }` returned:
  `{"status":"ok","surfaces":[],"entity_refs":["SECRET_PROJECT_ID"],"events":[]}`.
  Fix by treating scoped `stream_thread` as not found or out of scope when the scoped event query returns zero rows, and do not decrypt or return thread-level metadata until after the thread is proven to contain at least one allowed event. Add a regression test for a telegram-only thread queried from a discord-scoped server.

## P1 Findings (must fix before merge)
- P1 - packages/usrcp-stream/src/stitch/thread.ts:44
  Same-channel continuation keys omit `surface`, so the implementation links different surfaces when their `channel_ref` objects happen to canonicalize to the same JSON. The build spec requires same `(surface, channel_ref)`, not just same `channel_ref`. I proved this with a node script against `dist/stitch/thread.js`: a Discord event with `channel_ref: { id: "same-id" }` and a Telegram event with the same channel ref, 5 minutes apart, no entities, and no embeddings were assigned the same `thread_id`. Fix by including `input.surface` in the persisted recent-channel key, or by storing `{ surface, channelKey }` pairs and matching both fields. Add a regression test that same channel ref on different surfaces does not link via the same-channel gate.

## P2 Findings (should fix soon)
- P2 - packages/usrcp-local/src/server.ts:25, packages/usrcp-local/src/ledger/core.ts:54
  The stream package and newly authored lines are clean, but the strict "no em dashes anywhere" rule is still not true for touched local files. `rg -n $'\\u2014' packages/usrcp-stream packages/usrcp-local/src/server.ts packages/usrcp-local/src/ledger/core.ts tasks/usrcp-stream-codex-review.md` still reports existing U+2014 matches in `server.ts` and `ledger/core.ts`. If Chad intends the rule branch-wide, clean those files too. If only new stream-authored text matters, this can be marked explicitly out of scope.

## Verified Passing
- Branch state: local `feat/usrcp-stream` is at `439f2d9`, matching `origin/feat/usrcp-stream`.
- Stream suite: `npm test -- --reporter verbose` in `packages/usrcp-stream` passed 75 tests across 14 files.
- Local suite: `npm run build && npm test -- --reporter verbose` in `packages/usrcp-local` passed 372 tests across 18 files.
- Round-1 P0-2 looks closed: `master-key-stability.test.ts` now has frozen HKDF vectors for global, stream-events, stream-threads, stream-surface, stream-config, and blind-index derivations.
- Round-1 P0-3 looks closed: `false-pass-guard.test.ts` is now a subprocess mutation harness and the full stream suite restored the tree cleanly afterward.
- Round-1 P1-2 looks closed: `threads.topic_centroid` is now `TEXT` and is written through `encryptForColumn`; `encrypted-centroid.test.ts` verifies `enc:` storage and no raw float32 bytes in `stream.db`.
- Round-1 P1-3 looks mostly closed: config IO is shared through `config-io.ts`, `serve` loads saved config by omitting `embedder`, and tests cover Ollama plus vendor consent gates.
- Round-1 P1-4 looks closed: unified registration wires a ledger-backed entity resolver and tests cover backfill plus caller-supplied override.
- Focus markers: `rg -n "\\.only\\(|xit\\(|xdescribe\\(" packages/usrcp-stream` found no matches.
- Vendor env autodetection: `rg` found no `OPENAI_API_KEY`, `VOYAGE`, or provider env autodetection in stream source.

## Notes for Claude
The scoped thread leak is the one to fix first. Do not return any thread-level metadata in scoped mode until the allowed-surface event query proves the caller can see part of that thread. Then fold `surface` into same-channel matching so the new channel continuation path exactly matches the spec.
