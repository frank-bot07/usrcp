# USRKey Page Format — v0.1 (draft)

**Status: draft.** This document specifies the USRKey page format: a small set of
markdown files in which a person describes themselves *for their AI tools*, on
their own terms. It is the user-facing flip of the agent-file pattern
(`soul.md` / `tools.md` / `identity.md` / `heartbeat.md` / `memory.md`) — the
same mechanics, pointed the other direction.

Governing principles live in [MANIFESTO.md](../MANIFESTO.md). The format is
deliberately open: copy it, implement it, fork it. Conforming implementations
are the goal (invariant 5).

---

## 1. The pages

A USRKey is six markdown files. Nothing exists in a page unless the user chose
to write it (or approved a proposal — §4). **Consent by authorship.**

| Page | What it holds | Freshness | Default sensitivity |
|---|---|---|---|
| `identity.md` | Who I am: name, role, languages, location/timezone | Years | Low |
| `stack.md` | My world: tools, environment, conventions, how I work | Months | Low |
| `now.md` | What's true *this week*: current focus, situation, travel | **Days** | Medium |
| `history.md` | Durable facts I've chosen to keep; append-mostly | Long-lived | Medium |
| `boundaries.md` | How to treat me. What never to infer, store, or ask about | Stable | **High — never auto-shared** |
| `agents.md` | My tools, and what each is allowed to see and propose (§3) | As needed | High — policy, not payload |

Rules of thumb:

- **Small.** A page should be readable in one minute; under ~200 lines. The key
  is a passport, not a biography.
- **Plain markdown.** H1 title, prose and bullets. No required schema inside the
  body — humans write these.
- **Optional frontmatter**: implementations may read `updated:` (ISO date) to
  drive staleness nudges. Absence is not an error.
- A page that doesn't apply may be absent. An absent page grants nothing and
  implies nothing.

## 2. Bundles (how tools receive pages)

Tools never read the pages directly from the user's master copy. They receive a
**bundle**: a rendered, per-tool concatenation of only the pages that tool is
granted in `agents.md`.

A bundle:

- begins with the marker line `<!-- usrkey:bundle for=<tool> rendered=<ISO date> -->`
- contains the granted pages in the order listed in §1, each under its H1
- ends with `<!-- usrkey:end -->`

Delivery is implementation-defined. The reference implementation targets three
channels, in increasing order of integration:

1. **Paste card** — render to clipboard/file; the user pastes it into any chat
   UI. Works with every model on day one, zero integration.
2. **File injection** — write the bundle where the tool already auto-loads
   context (`CLAUDE.md` include, `.cursorrules`, `AGENTS.md`, etc.).
3. **MCP** — the bundle exposed as a resource/tool over the Model Context
   Protocol, with scope enforcement at the server.

## 3. `agents.md` — policy as prose

`agents.md` is both human-readable documentation of the user's tools **and**
machine-readable policy. One section per tool:

```markdown
## cursor
pages: identity, stack, now
writeback: propose (now, stack); none (others)

## claude-desktop
pages: identity, stack, now, history
writeback: propose (all granted)

## anything-else
pages: identity
writeback: none
```

- `pages:` — which pages this tool's bundle may contain. `boundaries.md` content
  is **never** included in a bundle by default; granting it requires naming it
  explicitly.
- `writeback:` — per page: `none` | `propose` | `auto-accept`. See §4.
- `## anything-else` (literal name) — the default policy for tools not listed.
  If absent, unlisted tools get nothing.
- Implementations parse only the `pages:` and `writeback:` lines; everything
  else in a section is human commentary and MUST be preserved untouched.

## 4. Writeback: changes happen by proposal

Tools do not edit pages. Tools **propose**.

1. **Propose.** A tool submits `(page, change, reason)`. The change is a diff or
   an appended block. The proposal is queued with full provenance: tool,
   timestamp, reason.
2. **Review.** The user sees proposals as diffs — accept, reject, or edit. This
   is the product's heartbeat moment ("Cursor proposed 2 additions to
   stack.md").
3. **Apply.** Accepted changes are written with attribution (proposed-by,
   accepted-on) retained in the implementation's history. Pages stay clean
   prose; provenance lives in the audit layer, not inline.
4. **Auto-accept** (opt-in, per tool, per page in `agents.md`) applies proposals
   immediately but identically logged and instantly revertible. Recommended
   ceiling: `now.md` only. `boundaries.md` is propose-only in every conforming
   implementation — no exceptions.

A tool that writes pages directly, without the proposal path, does not conform.

## 5. Conformance levels

The format is a ladder, so a plain-files weekend implementation and a full
encrypted vault are both honest about what they provide:

- **Level 0 — Pages.** The six files, plain markdown, any storage. (The
  [usrkey-template](https://github.com/frank-bot07/usrkey-template) is Level 0.)
- **Level 1 — Scoped render.** Bundles per §2, policy per §3, proposal flow per
  §4. No claims about storage.
- **Level 2 — Vault.** Level 1, plus the five [manifesto](../MANIFESTO.md)
  invariants: encrypted at rest under a user-held key, scoped consent enforced
  (not advisory), tamper-evident audit, free export, multi-device sync without
  a plaintext-reading server. [USRCP](https://github.com/frank-bot07/usrcp) is
  the reference Level 2 implementation: pages are ingested into the encrypted
  ledger as structured facts; bundles are rendered from it (the existing
  `refresh-context` pipeline is the seed); the proposal queue rides the ledger's
  append-only, HMAC-chained audit machinery.

Be plain about your level. A Level 0 implementation that markets vault language
("encrypted", "zero-knowledge") is misrepresenting the format.

## 6. What this format is not

- Not a profile to be mined: bundles exist for the user's benefit, rendered at
  the user's command. See the manifesto's prohibitions.
- Not identity/auth. Pages carry context, not credentials. Nothing in a bundle
  should grant account access anywhere.
- Not a place for data about *other people* beyond what the user would say out
  loud in a meeting. Implementations should warn when a proposal appears to add
  third-party personal data.

## 7. Versioning

This spec is versioned with recorded reasoning, per the manifesto's stewardship
section. Page names and §1-§4 semantics are stable within a major version.
Implementations should ignore unknown pages rather than fail.

---

*v0.1 — June 2026. The pages are copyable on purpose. The protocol for changing
them safely is the work.*
