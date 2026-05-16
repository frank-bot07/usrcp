# usrcp-claude-code

USRCP capture adapter for the Claude Code CLI. Tails the JSONL session transcripts under `~/.claude/projects/<encoded-cwd>/<sessionUUID>.jsonl` and writes each user / assistant turn into the encrypted `usrcp-stream` database.

This adapter is stream-only: every record it captures is a conversational turn and lands as a `surface: "claude-code"` event in `stream.db`. There is no ledger destination - the ledger is for structured user state (identity, preferences, projects), not turn-by-turn chat.

## Why claude-code, not claude-desktop?

The original Phase 6 prompt named `claude-desktop` (the GUI app) as the target. Claude Desktop stores conversational state in LevelDB binary blobs under `~/Library/Application Support/Claude/IndexedDB/`; the plaintext JSON files under `claude-code-sessions/` are session metadata only (sessionId, cwd, model, title), not turn content. Real capture means a LevelDB library and reverse-engineering Anthropic's IndexedDB schema, which is undocumented and likely to break across Electron / Claude Desktop updates.

Claude Code CLI's session storage IS plaintext JSONL today, with a stable per-turn schema and append-only writes. That's the surface this adapter targets.

## Install

```bash
cd packages/usrcp-claude-code
npm install
npm run build
```

## First-run

1. Edit `~/.usrcp/claude-code-config.json` to add the project paths you want captured:

   ```json
   {
     "allowlisted_projects": ["/Users/you/code/project-a", "/Users/you/code/project-b"],
     "file_offsets": {},
     "poll_interval_ms": 2000
   }
   ```

   Project paths are matched against the `cwd` field recorded by Claude Code in each turn. The encoded directory under `~/.claude/projects/` is derived by replacing `/` with `-`.

2. Start the adapter:

   ```bash
   USRCP_PASSPHRASE="$YOUR_PASSPHRASE" node packages/usrcp-claude-code/dist/index.js
   ```

   Or run once and exit (useful for cron):

   ```bash
   USRCP_PASSPHRASE="..." node packages/usrcp-claude-code/dist/index.js --once
   ```

## What gets captured

Each line in `~/.claude/projects/<encoded>/<sessionUUID>.jsonl` is one of:

| Line type           | Captured? | Notes |
|---------------------|-----------|-------|
| `type: "user"`      | Yes (outbound) | The human's prompt. |
| `type: "assistant"` | Yes (inbound)  | Claude's reply. `tool_use` and `tool_result` blocks inside the content array are skipped; only `text` blocks are concatenated into `content`. |
| `isSidechain: true` | No        | Sub-agent invocations. |
| `type: "queue-operation"` | No  | Internal command queue ops. |
| `type: "attachment"`      | No  | File / image attachments. |
| `type: "ai-title"`        | No  | Auto-generated session titles. |
| `type: "last-prompt"`     | No  | Internal bookkeeping. |

The captured `channel_ref` shape is `{ project: <cwd>, sessionId: <uuid>, gitBranch?: <branch> }`. The cross-surface stitcher uses these to thread Claude Code turns within the same session and (when entity refs or topic similarity match) link them to events from other surfaces.

## Resume + offsets

The adapter persists a byte offset per JSONL file under `file_offsets` in the config. On restart it resumes reading each file from its last known offset. If a file's size has shrunk since the last poll (truncation), the adapter resets that file's offset and re-scans from start.

If you add a project to `allowlisted_projects` after the fact, the next tick will backfill all existing session turns under that project. This is by design - it lets you onboard projects retroactively.

## Out of scope (v0.1)

- Tool calls (`tool_use` / `tool_result` content blocks) are not captured. v0.2 may add them as their own `content_kind`.
- File-watcher notifications. Polling at 2 second intervals is sufficient for capture latency and avoids a chokidar dependency.
- Windows support is untested; the home-dir lookup uses `os.homedir()` so it should work in principle.
- Encrypted `~/.usrcp/claude-code-config.json` like the stream-config flow. The config here holds project paths and byte offsets, neither of which are sensitive enough to need encryption-at-rest at v0.1.
