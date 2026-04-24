# USRCP Go-To-Market Strategy

**Two Wedges: Security-Conscious Developers and Regulated Enterprises**

---

## Positioning

USRCP is **not** general-purpose AI memory. Mem0 and Zep have that market covered and we will not out-execute them on semantic recall over chat history. USRCP is the structured-state and zero-knowledge layer — the thing you use when you need identity, preferences, projects, and interaction timeline to flow between Claude Desktop, Cursor, Continue, and Cline, and the thing you deploy when a memory provider seeing plaintext is a compliance non-starter.

The two wedges follow from this:

1. **Security-conscious developers** who use multiple AI editors daily and want their structured state (stack, style, projects) to follow them across tools, but don't want a third-party memory vendor reading their work.
2. **Regulated-industry enterprises** (health, finance, legal) for whom the zero-knowledge hosted ledger is not an upsell — it is the only memory architecture their compliance team will sign off on.

Grassroots first (developer wedge), enterprise second (compliance wedge). The developer wedge generates the proof, the stars, and the integrations. The enterprise wedge generates the revenue.

---

## The Problem with Protocol Adoption

New protocols die in committee. The graveyard is full of technically superior standards that never hit critical mass because they launched top-down: publish spec → wait for adoption → wonder why nobody cares.

USRCP launches bottom-up. We build one integration so good that developers adopt the protocol without knowing they're adopting a protocol.

---

## The Trojan Horse: Local MCP Server for Claude Desktop / Cursor / Any MCP Editor

### Why This Is The Developer Wedge

The first integration is a **local MCP server** that any MCP-compatible AI agent can call:

1. **MCP is already winning.** Claude Desktop, Cursor, Continue, Cline, Zed, Windsurf — dozens of agents speak MCP. We plug into the integration pattern they already use; we're not asking anyone to adopt a new one.

2. **Narrow, honest value prop.** Install the MCP server. Every agent on your machine can now read and write the same structured state — your identity, your preferences, your active projects, your domain-scoped context, and your interaction timeline. Write a preference in Claude Desktop; Cursor sees it on the next call. The pitch is cross-platform structured state, not "AI that remembers everything."

3. **Zero infrastructure.** The local MCP server runs an encrypted SQLite ledger on `localhost`. No cloud dependency. No account creation. No friction. `npx usrcp init` and you're running.

4. **Graduation path to the hosted ledger.** When developers want cross-device sync or team-scoped ledgers, they upgrade. The protocol is the same — they just configure a `cloud_endpoint` and the local client starts pushing ciphertext to the sync server. The hosted ledger never sees plaintext.

### The Install Experience

```bash
npx usrcp init --client=claude,cursor
```

This does three things:
1. Creates `~/.usrcp/users/<slug>/` with an encrypted SQLite ledger and per-user keys (passphrase-derived master key, never written to disk in passphrase mode).
2. Registers USRCP as an MCP server in both Claude Desktop's and Cursor's MCP config files. Also supports `continue` and `cline`, or `--client=all`.
3. Serves on stdio when the agent spawns it (default) or on HTTPS with a bearer token when run with `--transport=http`.

Every Claude Desktop session, every Cursor chat, every MCP-compatible agent can now call `usrcp_get_state` for the user's identity/preferences/projects/timeline and `usrcp_append_event` / `usrcp_set_fact` to write back.

### Why MCP and Not a Standalone SDK?

An SDK requires developers to write integration code. An MCP server requires them to write **nothing** — the agent runtime already knows how to call MCP tools. We're giving their existing agents cross-platform structured state for free, which is the first thing a user notices because it eliminates the daily "re-explain your stack" tax.

---

## Bypassing the Cold Start Problem

New protocols have a chicken-and-egg problem: no users → no integrations → no users.

USRCP bypasses this because **the local MCP server is both the producer and consumer of structured state on day one.**

### Day 1 Value (Single User, Single Machine)

Even with zero network effects, the local ledger provides:
- Structured identity and preferences that persist across sessions. "I'm a TypeScript founder, verbose output, Pacific timezone" — written once, available everywhere.
- Cross-editor state sharing: register with Claude Desktop and Cursor, write in one, read in the other.
- Interaction timeline and active-project tracking, scoped per domain.

This is already better than what exists for the structured-state use case:
- **Platform memory (Claude, ChatGPT)** is locked to that platform and hands your plaintext to the vendor.
- **`CLAUDE.md` / `.cursorrules`** are static, per-repo, manually maintained, and not cross-tool.
- **Custom vector DBs** solve semantic recall, not structured state, and require the developer to build the integration themselves.

### Day 30 Value (Per-User Compound Interest)

- Schemaless facts table lets domains store data the fixed schema doesn't model (habits, recurring tasks, relationships) without needing a schema migration.
- Per-domain encryption isolation: coding-domain keys cannot decrypt health-domain data. Cryptographically enforced, not policy-enforced.
- Multi-user local layout: shared family laptop or shared developer laptop, each human gets their own passphrase-protected ledger.

### Day 90 Value (Cross-Device, Compliance-Grade)

- Hosted sync ledger (packages/usrcp-cloud) for cross-device: push from laptop, pull on phone. Server stores **ciphertext only** — the operator cannot read user data.
- Team-scoped ledgers for shared project context (v0.2+).
- Compliance-grade deployment: BAA-ready, audit-log-signed, SSO, for regulated industries where no existing memory vendor can honestly offer a zero-knowledge story.

---

## The 1,000 Developer Playbook

### Phase 1: Seed (Week 1-4) — Developer Wedge

**Target**: AI-native indie developers already using 2+ AI editors daily.

1. **Ship `usrcp-local` as an npm package.** One command install. README shows a before/after: "Here's a Cursor session without USRCP: you re-explain your stack. Here's one with it: Cursor already knows because you told Claude Desktop yesterday."

2. **Launch on Hacker News** with the framing: *"We built structured user state as a protocol, not a product. MCP routes models. ACP routes agents. USRCP carries the human's structured state across both — encrypted, zero-knowledge, no vendor can read your state."* Lead with the cryptographic architecture, not the TAM.

3. **Post in Claude Desktop / Cursor / Continue / Cline communities.** Target users who already use two editors and feel the state-rebuilding tax.

4. **GitHub-first launch.** The spec, schemas, local MCP server, and hosted ledger scaffolding are all open source. Stars and forks are the early signal.

### Phase 2: Expand (Week 5-12) — Second-editor Integrations

5. **Verify cross-editor demo (Cursor).** Claude Desktop → structured write. Cursor → structured read. Same structured state, two editors, no vendor reads plaintext. This is the proof artifact the pitch needs; it makes the protocol story real.

6. **Continue.dev and Cline integrations.** Open docs-PR for each, list USRCP in their MCP examples. Cheap, credibility-boosting.

7. **Compliance positioning content.** One long-form post: "Why your memory vendor reading your plaintext is a compliance problem." Targets regulated-industry buyers who are already Googling this.

### Phase 3: Monetize (Week 12+) — Compliance Wedge

8. **Launch hosted sync ledger (usrcp.dev).** Free tier: 1 user, 10K events. Pro: $9/mo, multi-device. Team: $29/user/mo, shared ledger + per-user audit signing.

9. **Regulated-industry pilot.** Target one health-tech AI company + one legal-tech AI company. Pitch: *"Your agents need persistent user state, but HIPAA/privilege rules make Mem0 a non-starter. USRCP's hosted ledger stores ciphertext only — we built the system so we can't read the data even if compelled."* Sign BAA, integrate, get case study.

---

## Competitive Moat

| Competitor                           | How We Win                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform memory (Claude, ChatGPT)** | Locked to one platform; vendor reads plaintext. USRCP is portable and zero-knowledge.                                                       |
| **`CLAUDE.md` / `.cursorrules`**     | Static, per-repo, manual. USRCP is dynamic, cross-tool, schema + schemaless.                                                                 |
| **Custom vector DBs**                | Developer-built, per-app. USRCP is standardized and ships an MCP layer their agents already know how to call.                               |
| **Mem0 / Zep (semantic memory)**     | Different product. They do fuzzy recall over chat history; we do structured state with zero-knowledge encryption. Complementary, not rival. |

The moat is the **cryptographic architecture**, not the schema. Anyone can clone the schema; replicating zero-knowledge hosted sync with per-domain key isolation and cryptographically-signed audit logs is a rearchitecture project, and Mem0/Zep's current bet (semantic embeddings) has an accuracy ceiling that gets *worse* if they try to bolt on zero-knowledge. We don't need to win AI memory; we need to be the unquestionable choice for the structured-state and compliance tier.

---

## Key Metrics

| Metric | Week 4 Target | Week 12 Target |
|--------|---------------|----------------|
| npm installs of `usrcp-local` | 500 | 5,000 |
| GitHub stars | 1,000 | 5,000 |
| Daily active ledgers | 200 | 2,000 |
| Events appended / day | 10,000 | 500,000 |
| Hosted ledger signups | — | 500 |
