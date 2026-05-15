# Codex Review - feat/usrcp-stream (commit 99af162)

## Verdict
REJECT

## P0 Findings (blocking)
- P0 - packages/usrcp-stream/src/register.ts:104, packages/usrcp-stream/src/tools/stream-recall.ts:25, packages/usrcp-stream/src/tools/stream-thread.ts:39
  Scoped mode leaks out-of-scope stream data on multi-domain reads. `registerStreamTools` treats `scopeOf() === "all"` as allowed, but neither `stream_recall` nor `stream_thread` receives the allowed scope list and filters rows. I proved this with a node script against `dist/register.js`: a server launched with `serveOptions: { scopes: ["discord"] }` returned a `telegram` hit from `stream_recall` with snippet `SECRET_SCOPE_LEAK`, and `stream_thread` returned a `telegram` event with content `SECRET_THREAD_LEAK`. Fix by making unfiltered multi-domain reads in scoped mode either reject or inject the allowed scopes into the handler and filter SQL by `events.surface IN (...)`. Add regression tests that seed discord plus telegram rows, call scoped `stream_recall` without `surface`, and call scoped `stream_thread` for a mixed or out-of-scope thread.

- P0 - packages/usrcp-stream/src/__tests__/master-key-stability.test.ts:34
  `master-key-stability.test.ts` does not check the byte-for-byte HKDF invariant the review prompt required. I changed `packages/usrcp-local/src/encryption.ts:361` from `usrcp-encryption-v1` to `usrcp-encryption-v2`, rebuilt through `npm test -- --run src/__tests__/master-key-stability.test.ts --reporter verbose`, and all 3 tests still passed. The test only compares `Ledger.getMasterKey()` to `initializeMasterKey()`, which never exercises `deriveDomainEncryptionKey` or `deriveGlobalEncryptionKey`. Fix by asserting known derived key bytes for fixed master key plus domain, and by checking both stream and ledger derivation paths against frozen vectors.

- P0 - packages/usrcp-stream/src/__tests__/false-pass-guard.test.ts:16
  `false-pass-guard.test.ts` is not the false-pass mutation guard specified in the build prompt. It directly asserts crypto helper properties, but it never mutates the implementation and never asserts that other tests fail as a result. I separately no-opped `captureEvent`, `vectorSearch`, and `stitch` and confirmed targeted behavior tests fail, but this file itself does not perform or enforce that harness. Fix by making the guard execute controlled mutations in a temp copy or equivalent harness and assert that the relevant non-guard tests fail for capture, search, and stitch no-ops.

## P1 Findings (must fix before merge)
- P1 - packages/usrcp-stream/src/stitch/thread.ts:9, packages/usrcp-stream/src/stitch/thread.ts:36, packages/usrcp-stream/src/stitch/thread.ts:53
  Same-surface continuation is not implemented. The build spec requires matching same `(surface, channel_ref)` within `same_channel_window_ms`, but `StitchInput` has no `channel_ref`, thread rows do not store channel refs, and `same_channel_window_ms` is only used to widen the candidate time window. There is no score component or gate for same-channel continuation. Fix by passing an encrypted or comparable channel identity into the stitcher, persisting enough thread metadata to match it, and adding tests that fail when `same_channel_window_ms` is changed.

- P1 - packages/usrcp-stream/src/stitch/thread.ts:152, packages/usrcp-stream/src/stitch/thread.ts:178, packages/usrcp-stream/src/db/schema.ts:37
  `threads.topic_centroid` is stored as raw float32 bytes even though the build spec marks `topic_centroid BLOB` as encrypted and says every BLOB or encrypted JSON column goes through `encrypted-row.ts`. The code writes `bufferOfFloat32(...)` directly on create and attach. Fix by encrypting a stable serialized centroid representation before writing and decrypting it before cosine scoring, or get an explicit spec change before merging.

- P1 - packages/usrcp-stream/src/server.ts:26, packages/usrcp-stream/src/index.ts:63
  `serve` ignores the encrypted stream config written by `init`. `loadConfig()` is private to `index.ts` and is only used by `status`; `createStreamServer()` always probes Ollama and never constructs OpenAI or Voyage embedders from the saved provider, model, host, API key, or consent. It also means the README claim that config overrides are merged at runtime is false. Fix by moving config load/decrypt into shared code and using it during both standalone and unified registration.

- P1 - packages/usrcp-stream/src/capture/ingest.ts:39
  Best-effort entity extraction from the USRCP ledger is missing. The build spec says that when `entity_refs` are not supplied, capture should scan content for known entities by querying the in-process ledger if available. `captureEvent` only uses `parsed.entity_refs` and `IngestContext` has no ledger access. Fix by passing the optional ledger through registration and extracting active project aliases before stitching.

## P2 Findings (should fix soon)
- P2 - packages/usrcp-stream/package.json:4, packages/usrcp-stream/README.md:52, packages/usrcp-stream/src/server.ts:15
  The branch contains many U+2014 em dash characters despite the review prompt making them a hard reject for Chad. `rg -n $'\\u2014' packages/usrcp-stream packages/usrcp-local/src/server.ts` reports matches in README, package metadata, comments, tests, and tool descriptions. Fix by replacing U+2014 with plain hyphens or sentence breaks across the touched stream files and the local server diff.

- P2 - packages/usrcp-stream/README.md:70
  README says vendor providers require an explicit `--embedding-provider <vendor>` flag, but the interactive `init` flow can select OpenAI or Voyage without that flag. The code still requires a confirmation prompt, so I am not calling this a leak, but the documentation overstates the flag requirement. Fix either the doc or the init flow.

- P2 - packages/usrcp-stream/README.md:93
  README references future cloud sync and the Hermes pairing flow, which are not in this PR. The review prompt asked to check for accidental references to features outside the PR. Remove the future-product reference or move it to a follow-up design doc.

## Verified Passing
- Stream test suite: `npm test -- --reporter verbose` in `packages/usrcp-stream` passed 49 tests across 10 files with no reported skips.
- Local suite still passes after building stream: `npm run build && npm test -- --reporter verbose` in `packages/usrcp-local` passed 372 tests across 18 files.
- `usrcp-stream` build: `npm run build` in `packages/usrcp-stream` passed.
- Crypto primitive grep: production `packages/usrcp-stream/src` has no direct `createHash`, `createCipheriv`, `hkdfSync`, `scryptSync`, `generateKeyPair`, or `randomBytes` matches. Matches were in tests only. `encrypted-row.ts` imports crypto helpers from `usrcp-local/dist/encryption.js`.
- Encrypted event content write path: `captureEvent` writes `channel_ref`, `author_ref`, `content`, and `entity_refs` through `encryptJsonForColumn` or `encryptForColumn`; read paths in `stream_recall` and `stream_thread` decrypt via `decryptFromColumn` or `decryptJsonFromColumn`.
- On-disk event content sanity check: a node script wrote content `PLAINTEXT_NEEDLE_FOR_XXD`; the stored `events.content` began with `enc:` and `contains_plaintext=false`.
- No-op mutation checks: no-opping `captureEvent` made `capture-bidirectional.test.ts` fail 4 tests; no-opping `vectorSearch` made `vector-search.test.ts` fail 2 tests; no-opping `stitch` made `stitch-cross-surface.test.ts` fail 3 tests. Tree was restored after each mutation.
- Scope explicit rejection: existing `scope-enforcement.test.ts` verifies `stream_capture` rejects out-of-scope `surface=telegram` when scoped to discord, and explicit `stream_recall` with `surface=telegram` is rejected.
- Vendor env autodetection: `rg` found no `OPENAI_API_KEY`, `VOYAGE`, or provider env autodetection in `packages/usrcp-stream/src`; provider constructors require literal `vendorConsent: true`.
- Focus markers: `rg -n "\\.only\\(|xit\\(|xdescribe\\(" packages/usrcp-stream` found no focus markers.
- MCP tool surface: `mcp-tools.test.ts` covers all six `stream_*` tools.

## Notes for Claude
Fix the scoped read leak first. It is a confidentiality break, not a test nit. After that, replace the crypto and false-pass guard tests with tests that actually fail under the mutations described above. Then implement the missing same-channel stitch path and make `serve` consume the encrypted config it writes during `init`.
