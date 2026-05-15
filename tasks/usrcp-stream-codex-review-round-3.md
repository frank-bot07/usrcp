# Codex Review Round 3 - feat/usrcp-stream (commit 6496392)

## Verdict
APPROVE WITH CHANGES

## P0 Findings (blocking)
- None.

## P1 Findings (must fix before merge)
- P1 - packages/usrcp-stream/src/stitch/thread.ts:55
  `thread.ts` contains a literal NUL byte in the source string returned by `channelKey`. `file packages/usrcp-stream/src/stitch/thread.ts` reports `data`, and `git diff 439f2d9..6496392 -- packages/usrcp-stream/src/stitch/thread.ts` reports the TypeScript file as binary. `nl -ba packages/usrcp-stream/src/stitch/thread.ts | sed -n '42,56p' | cat -v` shows the separator as `^@`. The behavior is correct, but tracked TypeScript source must remain normal text for review, patching, grep, and tooling. Fix by replacing the literal NUL with an escaped sequence such as `"\\u0000"` or a plain textual delimiter that cannot collide with serialized JSON.

## P2 Findings (should fix soon)
- None.

## Verified Passing
- Branch state: local `feat/usrcp-stream` is at `6496392`, matching `origin/feat/usrcp-stream`.
- Stream suite: `npm test -- --reporter verbose` in `packages/usrcp-stream` passed 78 tests across 14 files.
- Local suite: `npm run build && npm test -- --reporter verbose` in `packages/usrcp-local` passed 372 tests across 18 files.
- Round-2 P0 fixed: manual scoped `stream_thread` probe against a telegram-only thread from a discord-scoped server now returns `{"status":"not_found","thread_id":"...","events":[]}` with no thread metadata.
- Round-2 P1 fixed behaviorally: manual same-channel probe with Discord and Telegram events using identical `channel_ref: { id: "same-id" }` now produces different thread IDs.
- Regression tests added for both round-2 findings in `scope-enforcement.test.ts` and `stitch-same-channel.test.ts`.
- Focus markers: `rg -n "\\.only\\(|xit\\(|xdescribe\\(" packages/usrcp-stream` found no matches.
- Vendor env autodetection: `rg -n "OPENAI_API_KEY|VOYAGE|COHERE" packages/usrcp-stream` found no provider env autodetection.
- Git worktree remained clean after the test runs.

## Notes for Claude
This is down to source hygiene. Replace the literal NUL byte in `channelKey` with an escaped or textual delimiter, rebuild, and rerun the stream suite. The two round-2 behavioral issues are closed.
