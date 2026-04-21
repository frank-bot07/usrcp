# Task 00 — Discord capture+reader adapter (end-to-end vision demo)

**Repo:** `/Users/frankbot/usrcp/` — new directory: `packages/usrcp-discord/`.

## Why this is task 00

Every other task in this directory is incremental polish on a foundation that **does not yet match the project's actual goal**. The goal is cross-channel memory: a user talks to an agent in Discord, then in Telegram, then in OpenClaw GUI, and the agent maintains continuity. Today, USRCP is a single-platform local memory store with a Claude Code MCP integration. The cross-channel layer is entirely unbuilt.

This task is the **smallest end-to-end proof of the actual vision**: pick one platform (Discord, since you already use it), build both the capture side (your messages → ledger) and the reader side (ledger → bot replies), and demonstrate that an agent in Discord remembers what you told it across channels and across restarts.

If this works cleanly, the architecture is validated and the same pattern replicates to Telegram, Slack, Signal, and the OpenClaw GUI. If it doesn't, you'll discover what's wrong with the schema or API *now* — before scaling to four more platforms compounds the mistakes.

## Goal

Build a single Discord bot that:

1. **Listens** to every message the user sends in any channel/thread the bot is in.
2. **Captures** each message as a USRCP timeline event with full channel/guild scoping.
3. **Reads** the user's USRCP state when @-mentioned and uses it to compose contextual replies.
4. **Demonstrates** continuity: the user can mention something in `#channel-A`, then in `#channel-B` ten minutes later ask "what was I just talking about?" and the bot answers correctly using state from channel A.

## What to do

### 1. New package: `packages/usrcp-discord/`

```
packages/usrcp-discord/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # entry point, discord.js client
│   ├── capture.ts         # message → USRCP event
│   ├── reader.ts          # USRCP state → LLM prompt
│   ├── llm.ts             # Anthropic client wrapper
│   └── config.ts          # env vars, channel allowlist, etc.
└── README.md
```

Dependencies: `discord.js`, `@anthropic-ai/sdk`, and the local USRCP client (call the local MCP server via the existing transport, or import `Ledger` directly from `usrcp-local` for v0).

### 2. Schema additions to USRCP

Add to `packages/usrcp-local/src/ledger.ts` and the timeline_events table:

```sql
ALTER TABLE timeline_events ADD COLUMN channel_id TEXT;       -- encrypted
ALTER TABLE timeline_events ADD COLUMN thread_id TEXT;        -- encrypted (nullable)
ALTER TABLE timeline_events ADD COLUMN external_user_id TEXT; -- encrypted (the Discord user ID)
```

These need to be encrypted with the global key like other text fields. Add a migration that handles existing databases (default new columns to encrypted-empty for old rows). Update `appendEvent` and `getRecentEvents` to round-trip these fields.

Also add a query method `getRecentEventsByChannel(channel_id, limit)` so the reader can pull channel-specific context efficiently.

### 3. Capture flow (`capture.ts`)

For every Discord message in an allowlisted channel:

1. Filter: ignore bot's own messages, ignore other users' messages (this is your personal context layer, not a multi-user logger — at least for v0).
2. Generate a one-line summary using the Anthropic API (Haiku 4.5 is plenty — fast, cheap):
   - Prompt: "Summarize this message in one sentence, capturing intent and any concrete entities. Message: {content}"
   - If the message is short (<200 chars), skip summarization and use the raw text.
3. Build the event:
   ```typescript
   {
     domain: "communication",        // or infer from channel name later
     summary: "<the summary>",
     intent: "<inferred intent>",    // optional, can omit for v0
     platform: "discord",
     detail: {
       guild_id: msg.guild.id,
       guild_name: msg.guild.name,
       channel_name: msg.channel.name,
       message_id: msg.id,
       raw_content: msg.content,    // store raw for reference; encrypted at rest
     },
     channel_id: msg.channel.id,    // new column
     thread_id: msg.thread?.id,     // new column
     external_user_id: msg.author.id, // new column
     tags: ["chat", `guild:${msg.guild.name}`, `channel:${msg.channel.name}`],
   }
   ```
4. Call `usrcp_append_event` (or `Ledger.appendEvent` if importing directly).

### 4. Reader flow (`reader.ts`)

When the bot is @-mentioned (or DMed):

1. Fetch user state via `usrcp_get_state` with scopes `["core_identity", "global_preferences", "recent_timeline"]`.
2. Fetch recent events specifically from the current channel via `getRecentEventsByChannel(channel_id, 10)`.
3. Fetch recent events globally (last 20) for cross-channel context.
4. Build a system prompt:
   ```
   You are an agent helping <user display_name>.
   
   Their identity: <core_identity>
   Their preferences: <global_preferences>
   
   What they've been doing across all platforms recently:
   <global timeline summaries, deduplicated, last 20>
   
   What they've been saying in THIS Discord channel:
   <channel-specific timeline, last 10>
   
   Respond to their current message. Be concise. Reference past context when relevant — if they ask "what was I just working on" you can answer specifically.
   ```
5. Call Anthropic API (Sonnet 4.6 for quality on the response side — Haiku for capture summaries was fine, but replies are user-facing).
6. Reply in the channel.
7. **Capture the bot's own reply too** — call `appendEvent` with `intent: "agent_reply"` so the next turn has continuity.

### 5. Configuration (`config.ts`)

Env vars:
- `DISCORD_BOT_TOKEN` — bot token
- `ANTHROPIC_API_KEY` — for summarization + reply generation
- `USRCP_PASSPHRASE` — passes through to the ledger
- `USRCP_DISCORD_CHANNELS` — comma-separated channel IDs to listen on (allowlist, prevents accidental ingestion of every channel in every guild)
- `USRCP_DISCORD_USER_ID` — your Discord user ID, so capture only fires for your messages

### 6. The demo script

Create `packages/usrcp-discord/DEMO.md` with the literal steps to reproduce the proof:

```
1. Start local USRCP: USRCP_PASSPHRASE=... usrcp serve
2. Start Discord bot: cd packages/usrcp-discord && npm start
3. In Discord channel #test-a: type "I'm working on the USRCP discord adapter"
4. In Discord channel #test-b (different channel): @mention bot "what was I just doing?"
5. Bot should reply with knowledge of the message from #test-a
6. Restart the bot process
7. In #test-c: @mention bot "remind me what I was working on earlier"
8. Bot should still know — proves persistence + cross-channel continuity
```

If steps 5 and 8 work, the vision is proven for one platform. The next platform (Telegram, Slack) is mostly the same code with a different message-source SDK.

### 7. Tests

Unit tests for `capture.ts` and `reader.ts` (mock Discord events, real ledger), plus a manual integration test described in DEMO.md. Don't go overboard — this is a vision-proof spike, not a hardened product.

## Out of scope (explicitly)

- **No hosted ledger.** Use the local one for now. Cross-device sync (running this bot on Railway while Telegram bot runs on Fly) is task 06 territory. For v0, run everything on Chad's laptop.
- **No multi-user.** Single user (you), filtered by `USRCP_DISCORD_USER_ID`.
- **No automatic domain inference.** Hardcode `domain: "communication"` for v0. Smart routing per channel/topic is a later refinement.
- **No reply-quality optimization.** As long as the bot demonstrates it has the context, the response quality is proven good enough.
- **No production deployment.** Localhost only.
- **Don't refactor `usrcp-local` beyond the schema additions.** Adapter consumes existing API.

## Acceptance criteria

The DEMO.md script runs end-to-end with the following observable behavior:

1. ✅ Messages in any allowlisted channel show up as encrypted rows in `timeline_events` with channel_id populated.
2. ✅ Bot @-mention in channel B retrieves and references content from channel A.
3. ✅ After restart, bot still has access to all prior context.
4. ✅ Inspecting the SQLite file directly shows ciphertext, never plaintext, in the encrypted columns.
5. ✅ Channel allowlist works — messages in non-listed channels don't get captured.
6. ✅ The DEMO.md walkthrough is recorded as a 60-90 second screencast and committed to the repo (or linked).

## What this proves (and what it doesn't)

**Proves:**
- The USRCP data model is rich enough to support real cross-channel agent memory.
- The capture/reader adapter pattern works.
- The protocol's actual value to a real human user is demonstrable.

**Does not prove:**
- That the model works across devices (needs hosted ledger — task 06).
- That it works at scale for many users (needs multi-tenant — phase 2 of task 06).
- That non-Discord platforms slot in cleanly (needs at least Telegram or Slack as a second adapter).

But it's the smallest possible artifact that turns "USRCP is a memory backend for Claude Code" into "USRCP is the user-context layer the project pitch describes."

## Files to read first

- `packages/usrcp-local/src/ledger.ts` — schema and CRUD
- `packages/usrcp-local/src/server.ts` — MCP tool surface
- `packages/usrcp-local/src/encryption.ts` — encryption patterns to reuse for new columns
- `sdk/dist/adapters/openclaw.js` — partial adapter pattern that exists today
- `discord.js` v14 docs for message events and guild intents
- `@anthropic-ai/sdk` quickstart for the LLM calls
