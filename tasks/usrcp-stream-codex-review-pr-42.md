# Codex Review - PR #42 Phase 6 (commit 08466b1)

## Verdict
APPROVE WITH CHANGES

## P0 Findings (blocking)
- None.

## P1 Findings (must fix before merge)
- P1 - `packages/usrcp-slack/src/index.ts:159`
  Slack DMs cannot be stream-captured, even when the DM channel is explicitly allowlisted. The first `app.message` handler returns immediately for `gme.channel_type === "im"` before it reaches `captureMessageToStream`, and the separate DM handler at `packages/usrcp-slack/src/index.ts:256` only calls `composeAndReply`. This contradicts `packages/usrcp-slack/README.md:61`, which says "stream capture in DMs requires adding the DM channel ID to `allowlisted_channels`." Proof: `rg -n "channel_type === \"im\"|captureMessageToStream|stream capture in DMs" packages/usrcp-slack/src/index.ts packages/usrcp-slack/src/__tests__ packages/usrcp-slack/README.md` shows the early DM return, no stream call in the DM handler, and no integration test covering a Slack DM stream event. Fix by adding the stream capture path to the DM handler when the DM channel is allowlisted, or by moving stream capture before the DM return while preserving the existing reply behavior. Add a test that an allowlisted DM reaches `captureMessageToStream` in `--mode stream` or `--mode both`.

## P2 Findings (should fix soon)
- P2 - `packages/usrcp-discord/README.md:81`, `packages/usrcp-telegram/README.md:65`, `packages/usrcp-imessage/README.md:59`, `packages/usrcp-slack/README.md:63`
  The READMEs say that if `usrcp-stream` is not installed, "the stream flag is unrecognized," but all four `resolveMode` implementations accept explicit `--mode stream` and `--mode both` even when `streamPresent` is false. The tests assert that behavior, for example `packages/usrcp-slack/src/__tests__/stream-capture.test.ts:164`. In that state the process would continue into the lazy stream client load and fail later, so the docs overpromise a clean CLI rejection. Fix either the docs or `resolveMode` so the user-facing behavior and tests agree.

## Verified Passing
- Branch state: local `feat/usrcp-stream-adapter-modes` is at `08466b1`, matching `origin/feat/usrcp-stream-adapter-modes` and local `pr-42-phase-6`.
- Stream suite: `npm test -- --reporter verbose` in `packages/usrcp-stream` passed 84 tests across 15 files.
- Discord suite: `npm test -- --reporter verbose` in `packages/usrcp-discord` passed 24 tests across 3 files.
- Telegram suite: `npm test -- --reporter verbose` in `packages/usrcp-telegram` passed 32 tests across 3 files.
- iMessage suite: `npm test -- --reporter verbose` in `packages/usrcp-imessage` passed 48 tests across 4 files.
- Slack suite: `npm test -- --reporter verbose` in `packages/usrcp-slack` passed 30 tests across 3 files.
- Local suite: `npm test -- --reporter verbose` in `packages/usrcp-local` passed 372 tests across 18 files.
- Combined local result: 590/590 tests passed.
- Focus markers: `rg -n -P "\\b(describe|it|test)\\.only\\s*\\(|\\b(xit|xdescribe)\\s*\\(" packages/usrcp-stream packages/usrcp-discord packages/usrcp-telegram packages/usrcp-imessage packages/usrcp-slack packages/usrcp-local` found no matches.
- Capture client factory reviewed: `createStreamCaptureClient(masterKey, userDir, options)` returns `{ capture, close, handle }`, uses `openStreamDb`, loads the vector extension, builds the stitcher, and preserves the three-state embedder rule used by `registerStreamTools`.
- Adapter capture mappings reviewed: Discord, Telegram, iMessage, and Slack populate required `ts_ms` from native timestamps and set optional `author.displayName` where the source exposes it.
- `main()` import guards reviewed: all four adapters gate startup behind `if (require.main === module)`.

## Notes for Claude
The Phase 6 shape is good: the stream client factory is a clean sibling API, adapter-local `stream-capture.ts` files keep the surface mappings understandable, and the ledger versus stream filters are mostly separated correctly. The Slack DM gap is the one merge blocker because the current README documents a path that the code cannot execute. After fixing that, add one handler-level test around an allowlisted DM so this does not quietly regress.
