# USRCP beta launch status: 2026-09-11

The promise: **Switch AI tools without starting the conversation over.**

The first beta is for people already using multiple AI tools. Normal use must not require choosing a project, copying a file, or asking an agent to save after every conversation. Connect tools once; evaluate automatic capture and fresh retrieval independently.

## Evidence

- Reviewed code: main `8b29022d1d5e4f73212b1233ab6e50a7d6427eda`, including PR #213 hardening.
- Main CI passed on September 9, 10 and 11. Latest verified run: https://github.com/frank-bot07/usrcp/actions/runs/34470986161.
- All 15 publishable packages built and packed locally. A missing local TypeScript installation was resolved by installing the locked dependencies.
- Clean candidate consumer install and audit passed; audit reported zero vulnerabilities. This is dependency-audit evidence, not a guarantee against all vulnerabilities.
- Two synthetic MCP clients exchanged state and a live condensed brief. Synthetic content markers were absent from 192 raw string cells across 11 tables. This is not actual-host acceptance evidence.
- Claude Code recorded a synthetic bakery project's decision and next step through `usrcp_append_event` without the user explicitly mentioning USRCP. The test used an isolated ledger and restricted tool permissions.
- Codex CLI reader acceptance remains unresolved: this test environment loaded unrelated Obsidian instructions and canceled its USRCP read. It did not recover the synthetic context. Do not describe Claude-to-Codex or Claude-to-Cursor natural continuation as proven by this run.

## Acceptance before a broad announcement

Use the natural-language pilot in [PILOT.md](PILOT.md). Demonstrate capture, retrieval, correction and an already-open reader refresh in two actual supported products. Keep a visible indication of missing or stale context. Record any manual intervention as friction, rather than editing it out of the demo.

## Beta invitation draft

I built USRCP because switching AI tools kept meaning explaining my work all over again.

It gives connected agents access to a local, encrypted record of recent work, decisions and preferences. My goal is simple: explain something once, then continue in another tool without copying a handoff file.

I'm opening a small, free beta for people who already switch between AI tools. The core sharing path is tested; automatic capture and recall still depend on the host integration. I want feedback on where the experience actually saves repetition and where it still gets in the way.

Repository: https://github.com/frank-bot07/usrcp

## First 30 days, measured from first participant

1. Days 1-3: observe setup and a real two-tool continuation with three participants. Fix their first blocking failure before adding integrations.
2. Days 4-7: expand to ten participants; record setup time, founder intervention, correct context and repeated explanations avoided. Do not collect their raw context by default.
3. Days 8-14: check voluntary return and incorrect/stale recall. Simplify whichever step repeatedly requires explanation.
4. Days 15-30: measure continued use and ask what users would miss. Test interest in a specific paid capability only after the free workflow helps. Publish findings with permission.

The engineering work can happen quickly. Retention evidence requires real elapsed use. GitHub stars are secondary.
