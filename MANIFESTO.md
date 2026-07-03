# USRKey — Your Context, Your Key

*A constitution for portable user context.*

*USRCP is the first implementation of this idea. It is not its definition. This document outlives any codebase, including ours.*

---

## The problem

You go from app to app, model to model, and explain yourself every time. Your stack, your projects, your preferences, your situation — retyped into every new assistant like it's 1999 and you're filling out another web form. Every AI tool you use keeps its own memory of you, or none. The understanding you've built with one assistant is held hostage by it.

This is not an accident of immature technology. It is an incentive. The better a vendor's memory of you, the higher your cost of leaving. No individual company will build portable context, because every company's reason to exist is to make *their* memory of you the reason you stay.

So it has to be built outside all of them, and belong to none of them.

## The claim

**Your context is yours.** Who you are, how you work, what you're building — that understanding should travel with you like a passport: carried by you, presented to whom you choose, readable only with your consent, valid everywhere.

A passport works because no airline owns it. The key works the same way: it is infrastructure that every tool can read and no vendor can capture.

## The invariants

Any implementation claiming to be a USRKey **must** guarantee all five. There are no partial keys.

1. **You hold the only key.**
   Your context's *content* is encrypted under a secret only the user controls. No provider, relay, host, or implementer can read that content — not by policy, but by construction. "We promise not to look" does not satisfy this invariant; "we cannot look" does. This invariant is about content, not metadata: sync and relay operate on ciphertext, but an operator may still see *traffic shape* — platform names, timing, volumes — which an implementation must disclose in writing (see the metadata prohibition below and the first implementation's [security model](docs/SECURITY.md#9-cloud-sync-relay--what-the-operator-sees)). Claiming "zero-knowledge" without that carve-out is the overclaim this document forbids.

2. **Consent is per-tool and scoped.**
   Each tool sees exactly what you grant — domain by domain, reads and writes separately — and nothing else. Every access is logged in a tamper-evident trail the user can audit. A tool that can read your health context because you granted it your coding context is a broken key.

3. **Leaving is free.**
   Full export of everything, in a documented format, at any time, in one step. An implementation that makes exit expensive — by format, by friction, or by fee — has become the thing this exists to fight.

4. **You can read your own ledger.**
   Nothing is stored about you that you cannot inspect, in plaintext, on your own machine. No hidden profiles, no derived scores you can't see, no "trust us, it's just embeddings."

5. **Infrastructure, not gatekeeper.**
   The format and protocol are open. Independent implementations are the goal, not a threat. No party — explicitly including the authors of this document — may make itself a mandatory intermediary between a user and their context.

## What it must never do

Prohibitions age better than promises. Any implementation, hosted service, or steward of this idea must never:

- **Train on your context.** Not opt-out. Never.
- **See plaintext server-side.** Sync and relay operate on ciphertext only. (Be honest about metadata: if timing, platform names, or volumes are visible to an operator, say so in writing — as the first implementation does in its [security model](docs/SECURITY.md).)
- **Silently widen a tool's scope.** Permission grants are explicit, visible, and revocable. No default expansions, no "we updated our terms."
- **Monetize the data itself.** Charge for software, hosting, support, or convenience — never for access to, or insight derived from, the user's context.
- **Hold your context hostage.** No feature, plan, or dispute may stand between a user and a complete export.

## What it is not

- **Not a semantic memory layer.** The key carries structured understanding — identity, preferences, projects, history — not fuzzy recall over everything you've ever said. Semantic memory tools are complementary, and a user may carry both. (The first implementation's [comparison](README.md#what-usrcp-is-vs-isnt) is the honest version of this boundary.)
- **Not identity or login.** The key carries *context*, not credentials. It tells a tool who you are in the sense that matters for being useful — not in the sense that grants account access.
- **Not a vendor.** The moment "the key" is something only one company can issue, this document has failed. Read invariant 5 again.

## Stewardship

- This document is versioned. Changes happen by public proposal and recorded reasoning, not silent edits.
- An implementation **conforms** when it upholds all five invariants and round-trips the documented export format. A conformance suite is the roadmap's job; the invariants are not negotiable while we build it.
- The measure of success is the day a second, independent implementation conforms — built by someone we've never met.

---

**v0.1 — June 2026.** Written alongside, but deliberately apart from, the first implementation: [USRCP](https://github.com/frank-bot07/usrcp).

*Your context is yours. Carry the key.*
