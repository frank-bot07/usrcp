# USRCP — Executive Summary for Investors

---

AI has an amnesia problem that costs every user time and every platform money. Today, a developer explains their stack to Claude Code, their writing style to ChatGPT, and their preferences to Cursor — and does it again tomorrow when the session resets. The industry has standardized how models are routed (MCP) and how agents communicate (ACP), but the human layer — the user's identity, preferences, interaction history, and project context — is completely fragmented across platforms, sessions, and devices. There is no protocol for an AI system to ask "who is this person and what do they care about?" and get a standardized answer. Every platform rebuilds this understanding from scratch, every session.

USRCP (User Context Protocol) is the open standard that fixes this. It defines a lightweight handshake for any AI agent to query and append to a user's **State Ledger** — a portable, append-only log of who the user is and what they've been doing across every AI system they touch. The protocol uses cryptographic **scoped context keys** to enforce domain isolation (a coding agent cannot read therapy bot logs), achieves sub-50ms latency via edge-cached state so it never bottlenecks LLM generation, and gives users full sovereignty over their data including zero-knowledge encryption for sensitive domains. The local MCP server installs in one command and gives every existing agent on a developer's machine instant persistent memory — no code changes required.

The business model is Stripe for AI Memory: the protocol is open source (Apache 2.0), the reference implementation is free and local-first, and revenue comes from hosted ledger infrastructure — cross-device sync, team context, enterprise audit and compliance features. The wedge is indie AI developers who feel the pain today; the market is every AI-using human on earth who is tired of starting every conversation from zero. We are building the third layer of the AI protocol stack, and we intend to be the default infrastructure provider for it.

---

**Ask**: $3M seed to ship the local MCP server, hosted ledger MVP, and first three platform integrations (Claude Code, Cursor, Obsidian).

**Team**: [To be filled]

**Contact**: [To be filled]
