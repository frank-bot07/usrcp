# Integration Outreach Tracker

> **Owner:** Frank
> **Updated:** 2026-04-21 (skeleton populated; no outreach sent yet)

This is where we track every non-Claude editor USRCP should work with,
and the status of making that real. "Setup doc exists" ≠ "editor
actually tested" ≠ "maintainers know we exist." Log all three.

## Status key

- **planned** — target identified, nothing sent
- **config-written** — `docs/INTEGRATIONS/<x>.md` exists but no live test
- **verified** — USRCP demonstrably works in this editor (video or written repro)
- **reached-out** — message sent to maintainers
- **responded** — maintainer replied (log sentiment)
- **listed** — editor's docs or curated MCP list includes USRCP

## Targets

| Editor | Contact surface | Status | Last touch | Notes |
|--------|----------------|--------|------------|-------|
| Cursor | Discord #feedback / Twitter to @amanrsanger | config-written | 2026-04-21 | Setup doc at docs/INTEGRATIONS/cursor.md. **Next: run `usrcp init --client=cursor` in a real Cursor install; record 30s demo; then DM/Discord.** |
| Continue.dev | GitHub issues on continuedev/continue | config-written | 2026-04-21 | Setup doc at docs/INTEGRATIONS/continue.md. **Next: verify `~/.continue/config.json` is still the right schema in current release; file a docs-PR to add USRCP to their MCP examples.** |
| Cline (VS Code) | GitHub issues on cline/cline | config-written | 2026-04-21 | Setup doc at docs/INTEGRATIONS/cline.md. **Next: verify the globalStorage path on a fresh VS Code install; smoke test then PR their MCP server list.** |
| Zed | Twitter / Zed community Discord | planned | — | Zed's MCP work is active but smaller user base. Defer until Cursor verified. |
| Windsurf | Their support channel | planned | — | Codeium-owned IDE. MCP support arrived mid-2025; worth a look once Cursor is a reference. |

## The demo artifact

The pitch hinges on showing **the same structured user state across two editors**. Script:

1. In Claude Desktop (or Claude Code): say "I'm a TypeScript founder building USRCP." Agent calls `usrcp_update_identity` and `usrcp_append_event`.
2. In Cursor: ask "What languages am I an expert in? And what am I working on?" Agent calls `usrcp_get_state`, returns TypeScript + USRCP.
3. Record 30s screencast. Publish at `docs/demos/cross-editor.mp4` (or Loom link).

Until this exists, the N=2 claim in the pitch is aspirational.

## Checklist per integration

Before moving a row to `verified`:

- [ ] `usrcp init --client=<x>` writes correct path on your OS
- [ ] Restart the editor; confirm USRCP tools appear
- [ ] `usrcp_get_state` returns the ledger you expect
- [ ] `usrcp_append_event` persists and is readable from a different client
- [ ] Document any Gotchas in the setup doc

Before moving a row to `reached-out`:

- [ ] A short loom/video showing the above, or at minimum a screenshot
- [ ] A one-paragraph pitch tailored to the editor's audience — not a generic copy/paste
- [ ] Offered concrete value (docs PR, blog post, co-marketing) rather than "notice us"

## Anti-patterns to avoid

- Sending the same message to three Discords in a day. Targeted > volume.
- Posting to a general `#announcements` channel without context. Reply to a specific user asking about cross-editor state or about compliance-grade memory, or engage with a maintainer's open question.
- Claiming "works with Cursor" before you've actually run it in Cursor. Brand damage is worse than silence.
