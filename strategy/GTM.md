# USRCP Go-To-Market Strategy

**Grassroots Adoption via The Wedge**

---

## The Problem with Protocol Adoption

New protocols die in committee. The graveyard is full of technically superior standards that never hit critical mass because they launched top-down: publish spec → wait for adoption → wonder why nobody cares.

USRCP launches bottom-up. We build one integration so good that developers adopt the protocol without knowing they're adopting a protocol.

---

## The Trojan Horse: Local MCP Server for Claude Code / Cursor / Any Agent

### Why This Is The Wedge

The first integration is a **local MCP server** that implements USRCP as a tool any local AI agent can call. Here's why:

1. **MCP is already winning.** Claude Code, Cursor, Windsurf, and dozens of agents already support MCP servers. We don't need to convince anyone to adopt a new integration pattern — we plug into the one they already use.

2. **Instant value prop.** Install the MCP server. Every agent on your machine now has persistent memory of who you are, what you're working on, and how you like to work. No more repeating yourself. No more re-explaining your codebase to a new session.

3. **Zero infrastructure.** The local MCP server runs a SQLite-backed ledger on `localhost`. No cloud dependency. No account creation. No friction. `npx usrcp-local` and you're running.

4. **Graduation path.** When developers want cross-device sync or team features, they upgrade to the hosted ledger. The protocol is the same — they just change the ledger URL.

### The Install Experience

```bash
# One command. That's it.
npx usrcp-local init

# Or for Python-centric devs
pip install usrcp && usrcp init
```

This does three things:
1. Creates `~/.usrcp/ledger.db` (SQLite) and `~/.usrcp/keys/` (local keychain)
2. Registers as an MCP server in Claude Code config (`~/.claude/mcp_servers.json`)
3. Starts serving on `localhost:7437` (USRCP default port)

Now every Claude Code session, every Cursor chat, every local agent that speaks MCP can call:
- `usrcp_get_state` — "Who is this user? What are they working on?"
- `usrcp_append_event` — "Record that we just deployed the auth refactor"

### Why MCP and Not a Standalone SDK?

An SDK requires developers to write integration code. An MCP server requires them to write **nothing**. The agent runtime already knows how to call MCP tools. We're not asking developers to build with USRCP — we're giving their existing agents superpowers for free.

The SDK exists for developers who want deeper integration. But the wedge — the thing that gets the first 1,000 users — is the zero-code MCP server.

---

## Bypassing the Cold Start Problem

New protocols have a chicken-and-egg problem: no users → no integrations → no users.

USRCP bypasses this because **the local MCP server is both the producer and consumer of state on day one.**

### Day 1 Value (Single User, Single Machine)

Even with zero network effects, the local ledger provides:
- Persistent memory across agent sessions (no more "I'm a new session, I don't know your preferences")
- Cross-agent context (what you told Cursor is available to your CLI agent)
- Interaction history and project timeline

This is already better than what exists. Memory today is either:
- **Platform-locked** (Claude's memory only works in Claude)
- **Session-scoped** (gone when the window closes)
- **Manual** (CLAUDE.md files you maintain by hand)

### Day 30 Value (Network Effects Begin)

- Obsidian plugin syncs your notes/thinking into the ledger
- VS Code extension tracks coding sessions
- Browser extension captures research sessions
- All of this context is available to any agent via one `get_state` call

### Day 90 Value (Cross-Device, Teams)

- Hosted ledger for cross-device sync
- Team ledgers for shared project context
- Enterprise deployment with SSO and audit logs

---

## The 1,000 Developer Playbook

### Phase 1: Seed (Week 1-4)

**Target**: AI-native indie developers who are already using Claude Code or Cursor daily.

1. **Ship `usrcp-local` as an npm package.** One command install. README shows a before/after: "Here's a Claude Code session without USRCP. Here's one with it. The agent already knows your stack, your style, your projects."

2. **Launch on Hacker News** with the framing: "We built the missing layer in the AI stack. MCP routes models. ACP routes agents. Nothing routes the human. Until now."

3. **Post in Claude Code / Cursor / AI dev communities.** These are people who feel the pain every day. They restart sessions and re-explain context constantly.

4. **GitHub-first launch.** The spec, schemas, and local MCP server are all open source. Stars and forks are the early signal.

### Phase 2: Expand (Week 5-12)

5. **Build the Obsidian plugin.** Obsidian's community is technical, opinionated, and evangelical. They already believe in local-first, user-owned data. USRCP is philosophically aligned.

6. **Build the VS Code extension.** Passive — auto-records coding sessions to the ledger. Now any agent knows what files you touched, what you committed, what bugs you hit.

7. **Conference talks / YouTube content.** "The Three Protocol Stack" (MCP + ACP + USRCP) — position USRCP as the inevitable third layer.

### Phase 3: Monetize (Week 12+)

8. **Launch hosted ledger (usrcp.dev).** Free tier: 1 user, 10K events. Pro: $9/mo, unlimited. Team: $29/user/mo, shared context + audit log.

9. **Enterprise pilot.** Sell to AI-forward companies who want unified context across their agent fleet. "Your agents waste 40% of context window re-learning who the user is. USRCP eliminates that."

---

## Competitive Moat

| Competitor | Why We Win |
|-----------|-----------|
| **Platform memory (Claude, ChatGPT)** | Locked to one platform. USRCP is portable |
| **CLAUDE.md / .cursorrules** | Manual, static files. USRCP is dynamic, auto-updating |
| **Custom vector DBs** | Developer-built, per-app. USRCP is standardized, cross-app |
| **Mem0 / similar startups** | API-first, not protocol-first. No interop standard. Vendor lock-in |

The moat is the **protocol itself**. Once USRCP is the standard, we're the default hosted ledger — the way Stripe is the default payment processor despite open banking APIs existing.

---

## Key Metrics

| Metric | Week 4 Target | Week 12 Target |
|--------|---------------|----------------|
| npm installs of `usrcp-local` | 500 | 5,000 |
| GitHub stars | 1,000 | 5,000 |
| Daily active ledgers | 200 | 2,000 |
| Events appended / day | 10,000 | 500,000 |
| Hosted ledger signups | — | 500 |
