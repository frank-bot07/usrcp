# USRCP — Executive Summary for Investors

---

AI agents today rebuild their understanding of the user every session, on every platform, from scratch. A developer explains their stack to Claude Desktop, their coding style to Cursor, and their preferences to Continue — and does it again tomorrow when the session resets. The industry has standardized how models are routed (MCP) and how agents communicate (ACP), but the structured user state an agent needs to be useful on day two — identity, preferences, active projects, interaction timeline — is fragmented across platforms, sessions, and devices. Every platform rebuilds this understanding session-by-session, and the ones that do persist memory (Claude, ChatGPT) lock it inside their own walls and require the vendor to see plaintext.

USRCP (User Context Protocol) is the open standard for cross-platform, cryptographically-private structured user state. It defines a lightweight handshake for any AI agent to query, write, and sync to a user's **State Ledger** — a portable, append-only log with per-domain encryption keys the user controls, not the vendor. Coding context cannot decrypt health context. The hosted sync ledger stores ciphertext only — we built the system so that we, the operator, cannot read the user's data even if subpoenaed. This is what makes USRCP deployable in regulated industries (health, finance, legal) where Mem0 and Zep are not. We are not competing with semantic memory startups on fuzzy recall; we are building the structured-state and compliance layer they cannot match without rearchitecting.

The business model is open-source protocol, paid hosted ledger. The protocol is Apache 2.0; the local reference implementation is free; revenue comes from the hosted sync ledger — per-user ciphertext storage, team-scoped ledgers, compliance-grade audit features, BAA-ready deployment. The wedge is two-sided: (1) security-conscious indie developers who already use multiple AI editors and feel the "re-explain everything" pain daily, and (2) enterprise compliance buyers in regulated verticals for whom the zero-knowledge architecture is not a feature but a requirement. We are building the structured-state layer of the AI protocol stack, and we intend to be the default infrastructure provider for it — particularly in the compliance-sensitive tier where no other provider can honestly compete.

---

**Ask**: $3M seed to ship the hosted sync ledger, land three non-Claude editor integrations (Cursor, Continue, Cline), and close two regulated-industry pilots (one health, one legal or finance).

**Team**: [To be filled]

**Contact**: [To be filled]
