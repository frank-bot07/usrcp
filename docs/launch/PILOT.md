# USRCP human-context pilot

USRCP is the user's context layer across AI interfaces. Developers switching harnesses are the first cohort, not the limit of the product. This project is prelaunch; GitHub stars are not a demand measure.

## First successful handoff

1. Install the reviewed candidate. Initialize one passphrase-protected profile and use keychain storage if desired.
2. Register two clients: `usrcp adapter add terminal --targets=claude-code,codex --user=work` (Cursor is also in the initial cohort).
3. In client A, explain one small project, its current constraint and next step. Have it save the active project and a concise timeline event in USRCP.
4. Start a fresh session in client B. Ask only: "Continue my current project. What constraint and next step do you have?"
5. Confirm that B calls USRCP, states the correct facts and proceeds without a repeated briefing. Repeat in the reverse direction.
6. Correct one fact using `usrcp fact set --domain=coding --namespace=project --key=constraint --value-file=correction.json`. Confirm the next handoff uses the correction.
7. Run a negative control: a client scoped to another domain must not retrieve the project. A fresh profile must not see the original profile's state.

MCP server instructions ask clients to retrieve context automatically; a client may ignore them. Record that as an activation failure. A low-level MCP process test is necessary but does not replace this real-interface acceptance test. The primary path is a fresh `usrcp_handoff` read from the shared ledger. Also test B while it is already running: A saves a new decision, B refreshes within two minutes and uses it correctly. A Markdown file export is an optional fallback and must not count as live continuity. Whole-state synchronization is not required. Experimental device event sync is separate.

## Consent and measurement

Metrics are OFF by default. With explicit participant consent, `usrcp pilot enable` collects only local UTC days, successful handoff counts and one of four client categories. No prompts, facts, project names, identity, tokens, or network upload. `usrcp pilot export --output=pilot.json` creates a file the participant may choose to share. `usrcp pilot disable` clears stored aggregates. Retention is at most 60 days when recording.

A successful tool call is not proof the assistant used the answer correctly. Supplement counts with the observed task outcome and a weekly participant interview.

## Ten-participant experiment

Recruit people who already switch between AI interfaces at least several times per week. Include varied experience, not only friends willing to tolerate setup failures. No outreach is sent automatically.

Record participant pseudonym, tools, time to first correct handoff, founder intervention required, correct/incorrect context, useful days in each week, corrections, and willingness to pay for a specific proposed capability. Never collect raw working context by default.

Suggested decision thresholds (hypotheses, not industry benchmarks): 8/10 activate without founder repair; 6/10 still use it in week two; 3 accept a paid pilot for a clearly specified capability. Evaluate at day 30, not before the observation window exists.

## Interview prompts

- Show the last time you switched tools and had to repeat context.
- What do you use today to avoid doing that? What fails?
- Which USRCP handoff saved actual work? Which returned stale or irrelevant context?
- Did you return voluntarily after the first session? Why or why not?
- What would you miss if it disappeared tomorrow?
- For a concrete reliable-device-sync or managed-team offer: would you start a paid pilot now? Record an actual commitment, not a hypothetical compliment.

## Outreach draft

I'm building USRCP, a private context layer that carries your ongoing work between AI tools. I'm looking for developers who switch between Claude Code, Codex or Cursor to test whether it removes repeated project briefings. The pilot takes one observed setup and two short follow-ups over two weeks. You control your context; sharing raw prompts or code is not required. Would this match a problem you already have?

## Execution sequence

- Days 1-7, engineering: fix integrity/profile defects, update dependency locks, verify license/engines and packed installs, run PostgreSQL concurrency and cross-client tests.
- Days 8-14, activation: use one capability matrix and two-client walkthrough, inspect context and access, opt into aggregate measurement only with consent. Test actual harness behavior before advertising automatic continuity.
- Days 15-30, evidence: enroll ten participants, observe setup and week-two use, test a concrete paid offer, publish anonymized findings only with participant permission.

Do not wait seven days to finish engineering that can be completed sooner. Do not claim two-week retention without two weeks of real use.
