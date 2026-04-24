# Task 07 — Land first external agent integration

**Repo:** `/Users/frankbot/usrcp/`.

## Goal

Get USRCP running inside an editor that **isn't Claude Code**. The point is to prove cross-platform value (one user, two agents, same structured state) — once that demo exists, the protocol pitch becomes real. N=2 is when USRCP stops being a Claude-Code-only state backend and starts being a protocol.

## Target priority

1. **Cursor** — has MCP support, large user base, AI-first. Highest impact.
2. **Continue.dev** — open source, MCP-aware, reachable maintainers.
3. **Cline** — viable, smaller surface.
4. **Zed** — active MCP work, but smaller user base today.

## What to do

### 1. Cursor integration walkthrough

- Cursor uses MCP servers natively
- Write `docs/INTEGRATIONS/cursor.md` mirroring the Claude Code setup but for Cursor's MCP config location
- Test it end-to-end with a real Cursor install

### 2. Cross-platform demo

Build a recordable demo:

1. In Claude Code: write a session that establishes user identity ("I'm a TypeScript expert, working on USRCP")
2. In Cursor: ask "what languages am I expert in?" → USRCP returns the identity
3. Record a 30-second screencast showing the same structured state accessed from both editors

This is the proof artifact for the protocol pitch.

### 3. Outreach

- **Cursor team:** Discord / Twitter / email. Position as: "we built the cross-platform structured-state layer your users keep asking for in feedback threads — identity, preferences, projects, interaction timeline — happy to write a blog post about it." Lead with the demo video.
- **Continue.dev:** File a GitHub issue + open a PR adding USRCP to their docs as a recommended MCP server. Smaller team, more responsive.
- **Cline:** Similar PR pattern — add to their MCP server list.

### 4. Track outreach

Create `strategy/INTEGRATIONS.md` with status per target:

```markdown
| Target | Contact | Status | Last touch | Notes |
|--------|---------|--------|------------|-------|
| Cursor | discord | reached out | 2026-04-22 | waiting on response from Aman |
| Continue.dev | GH issue #123 | PR open | 2026-04-23 | reviewer assigned |
```

## Out of scope

- **Don't build custom adapters per editor.** MCP is the interop layer, that's the whole point. If an editor doesn't support MCP, deprioritize.
- Don't pay for placement, sponsorships, or ads. This is product-led outreach.

## Acceptance criteria

- USRCP works in at least one non-Claude editor (Cursor preferred)
- Documented setup guide exists at `docs/INTEGRATIONS/<editor>.md`
- Recorded demo (video file in repo or linked) showing same memory across two editors
- Outreach tracker exists with at least 3 contacts logged

## Files to read first

- `README.md` — current Claude Code setup pattern to mirror
- `packages/usrcp-local/src/index.ts` — `init` command (will need to support multiple MCP config locations after task 01)
- Cursor MCP docs: https://docs.cursor.com/context/model-context-protocol
- Continue.dev MCP docs
