# usrcp-hermes

USRCP memory provider plugin for [Hermes Agent](https://github.com/hermesagent/hermes-agent).

Adds USRCP as a ninth external memory provider. Your interaction history, identity, and domain context follow you across Hermes, Claude Code, ChatGPT, and Cursor — one encrypted local ledger, zero vendor lock-in.

## Architecture

```
Hermes (Python)
  └─ UsrcpMemoryProvider (this plugin)
       └─ UsrcpMcpClient (mcp.ClientSession + stdio_client)
            └─ usrcp serve  (Node.js subprocess, stdio MCP server)
                 └─ ~/.usrcp/users/<slug>/ledger.db  (SQLite, encrypted)
```

The plugin is a thin Python wrapper. Ledger logic stays TypeScript. One source of truth.

## Prerequisites

- `usrcp` CLI installed and on `$PATH`
- Ledger initialised: `~/.usrcp/users/default/ledger.db` must exist
- `mcp` Python package (`pip install mcp`)

## Install into Hermes (local testing)

```bash
# From the usrcp monorepo root:
cp -r packages/usrcp-hermes/usrcp_hermes ~/.hermes/plugins/usrcp

# Or as a symlink for live editing:
ln -s "$(pwd)/packages/usrcp-hermes/usrcp_hermes" ~/.hermes/plugins/usrcp
```

Then in Hermes:

```bash
hermes memory setup
# Select "usrcp" from the provider list
# Accept default user slug or enter yours

hermes memory status
# Expect: Provider: usrcp (active)

hermes chat
# "What was I working on yesterday?" → pulls from your USRCP ledger
```

## Configuration

The only Hermes-side config is `user_slug` (default: `"default"`), written to
`$HERMES_HOME/usrcp.json` (mode 0600).

Runtime config (encryption keys, ledger path) lives in `~/.usrcp/` — not Hermes'.

You can also override the user slug with:

```bash
export USRCP_USER_SLUG=myslug
```

## Hook implementation status

| Hook | Status | Notes |
|---|---|---|
| `is_available` | Implemented | Checks binary + ledger DB |
| `initialize` | Implemented | Spawns `usrcp serve`, MCP stdio |
| `system_prompt_block` | Implemented | `usrcp_get_state` → identity/prefs |
| `prefetch` | Implemented | `usrcp_search_timeline` → context text |
| `sync_turn` | Implemented | `usrcp_append_event`, background thread |
| `handle_tool_call` | Implemented | Proxy to MCP client |
| `get_tool_schemas` | Implemented | 6 tools with OpenAI-format schemas |
| `get_config_schema` | Implemented | `user_slug` field |
| `save_config` | Implemented | Writes `usrcp.json` at 0600 |
| `shutdown` | Implemented | Joins thread, closes MCP, kills subprocess |
| `on_session_end` | Deferred (v0.2) | Session-end fact extraction |
| `on_pre_compress` | Deferred (v0.2) | Pre-compression insight extraction |
| `on_delegation` | Deferred (v0.2) | Parent-side subagent observation |
| `on_memory_write` | Deferred (v0.2) | Mirror built-in memory writes |

## Running tests

```bash
cd /path/to/usrcp
pytest packages/usrcp-hermes/tests/ -v
```

Tests are fully offline — no subprocess is spawned, no MCP SDK calls hit the
network. The `FakeMcpClient` fixture intercepts all tool calls.

## Tools exposed to the LLM

| Tool | Description |
|---|---|
| `usrcp_get_state` | Full user state (identity, preferences, timeline, domain context) |
| `usrcp_append_event` | Record a meaningful interaction event |
| `usrcp_search_timeline` | Keyword search across past interactions |
| `usrcp_set_fact` | Store free-form facts (habits, goals, relationships) |
| `usrcp_get_facts` | Read stored facts |
| `usrcp_status` | Ledger health and statistics |
