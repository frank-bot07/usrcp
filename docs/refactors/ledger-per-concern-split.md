# Follow-up: per-concern `Ledger` split

**Branch:** `refactor/ledger-per-concern-split`
**Base:** `refactor/split-ledger` (commit `4fee107`)
**Status:** Design doc only. No code changes yet.

---

## Context

`refactor/split-ledger` landed a **partial** version of the split:

- `packages/usrcp-local/src/ledger.ts` → thin re-export shim
- `packages/usrcp-local/src/ledger/index.ts` → entire `Ledger` class (~1928 lines)
- `packages/usrcp-local/src/ledger/helpers.ts` → pure functions (ULID gen, Crockford constant, `getDefaultDbPath`, `safeJsonParse`)

The original spec asked for **seven** per-concern files:
`identity.ts`, `events.ts`, `facts.ts`, `timeline.ts`, `audit.ts`, `keys.ts`, `index.ts`.

Two sessions attempted this and both arrived at the same blocker, quoted from
commit `4fee107`:

> The class's private methods (`encryptForDomain`, `safeDecryptForDomain`,
> `handleTamper`, `resolveDomain`, etc.) are shared across almost every
> public method. Splitting the public methods across files without first
> exposing those helpers — or adopting a mixin / `Object.assign` pattern —
> produces churn without real isolation.

This doc exists so the next session doesn't repeat the analysis.

---

## Non-obvious dependencies that force the design

Cross-file calls that any split must accommodate:

| Caller (topic) | Callee (topic) | Coupling |
|---|---|---|
| `rotateKey` (keys) | `updatePreferences` (identity) | Resets tamper tracker after successful rotation |
| `rotateKey` (keys) | `rebuildBlindIndex` (keys) | Own file — fine |
| `rotateKey` (keys) | `logAudit` (audit) | Logs key_rotation + key_rotation_skipped |
| `appendEvent` (events) | `logAudit` (audit) | Every append is audited |
| `appendEvent` (events) | `getBlindTokens` (core) | Writes blind index tokens |
| `getTimeline` (timeline) | `rowToEvent` (timeline) | Own file — fine |
| `getState` (identity) | `getTimeline` (timeline) | Composite state includes recent timeline |
| `searchTimeline` (timeline) | `getSearchTokens` (core) | Blind index lookup |
| `setFact`/`getFact` (facts) | `factLookupHash` (facts) | Own file — fine |
| Every topic | `encryptForDomain`, `decryptForDomain`, `safeDecryptGlobal`, etc. (core) | Shared encryption helpers |

Two tricky ones in that list:

1. **`getState` (identity) → `getTimeline` (timeline).** A pure parent→child
   inheritance chain can't do this without either reordering or forward
   declarations. Putting `getState` at the tail of the chain (its own module
   after timeline) works.
2. **`rotateKey` (keys) → `updatePreferences` (identity).** Forces `keys`
   to come *after* `identity` in any chain — which conflicts with the
   intuition that `keys` is "lower level."

---

## Three viable patterns

### Pattern A — Prototype augmentation with `declare module` merging

**Sketch:**

```typescript
// ledger/core.ts
export class Ledger {
  db!: Database.Database;
  masterKey!: Buffer;
  constructor(dbPath?: string, passphrase?: string) { /* ... */ }
  close(): void { /* ... */ }
  // Shared helpers — drop `private` keyword so augment files can access them.
  /** @internal */ encryptForDomain(plaintext: string, domain: string): string { /* ... */ }
  // ...
}

// ledger/identity.ts
import { Ledger } from "./core.js";
import type { CoreIdentity } from "../types.js";

declare module "./core.js" {
  interface Ledger {
    getIdentity(): CoreIdentity & { tampered?: boolean; version: number };
    updateIdentity(identity: Partial<CoreIdentity>, expectedVersion?: number): number;
  }
}

Ledger.prototype.getIdentity = function (this: Ledger) { /* ... */ };
Ledger.prototype.updateIdentity = function (this: Ledger, identity, expectedVersion) { /* ... */ };

// ledger/index.ts
import { Ledger } from "./core.js";
import "./audit.js";
import "./identity.js";
import "./keys.js";
import "./timeline.js";
import "./events.js";
import "./facts.js";
export { Ledger };
```

**Pros:**
- No inheritance chain. No ordering constraints beyond "core before augments."
- Class identity preserved (`instanceof Ledger` works everywhere).
- TypeScript interface merging gives full type safety.
- Side-effect imports in `index.ts` are idiomatic for this exact pattern.

**Cons:**
- Requires dropping `private` from fields/helpers that cross file boundaries. They become "package-internal" documented via `@internal` JSDoc. Runtime was never private anyway (no `#` fields used in the class).
- Prototype manipulation at module load is non-obvious to a newcomer.
- If an augment file is *not* imported, its methods silently don't exist. The `index.ts` barrel has to import all six topic files for their side effects.

**Proven viable** — pattern tested in a /tmp toy during the session that produced this doc; the toy type-checks under strict mode and runs correctly.

**Verdict:** recommended.

---

### Pattern B — Mixin class chain

**Sketch:**

```typescript
// ledger/core.ts
export class LedgerCore {
  protected db: Database.Database;
  protected masterKey: Buffer;
  // ...
}

// ledger/audit.ts
import { LedgerCore } from "./core.js";
export class LedgerAudit extends LedgerCore {
  logAudit(...) { /* ... */ }
  getAuditLog(...) { /* ... */ }
}

// ledger/identity.ts
import { LedgerAudit } from "./audit.js";
export class LedgerIdentity extends LedgerAudit {
  getIdentity(...) { /* ... */ }
  updateIdentity(...) { /* ... */ }
}

// ledger/keys.ts — but this needs updatePreferences from identity
import { LedgerIdentity } from "./identity.js";
export class LedgerKeys extends LedgerIdentity {
  rotateKey(...) { /* uses this.updatePreferences() */ }
}

// ledger/index.ts
import { LedgerFacts } from "./facts.js";
export { LedgerFacts as Ledger };
```

**Pros:**
- Pure TypeScript. No prototype manipulation.
- `protected` fields replace the "package-internal" hack.
- Class identity preserved via `export { X as Ledger }`.

**Cons:**
- Creates a rigid ordering: each class extends exactly one other. Any parent→child call requires either reordering the chain or `(this as any)` casts.
- `getState` (composite) must live at the tail — pushes identity down the chain.
- Six levels of inheritance make stack traces deeper and `instanceof` checks slightly more expensive (negligible, but real).
- Renaming a class in the chain cascades renames through the file graph.

**Verdict:** viable but more mechanically fragile than A. Recommend only if the reviewer strongly prefers no prototype manipulation.

---

### Pattern C — Dependency-injection via pure-function modules

**Sketch:**

```typescript
// ledger/identity.ts
export interface IdentityCtx {
  db: Database.Database;
  masterKey: Buffer;
  encryptGlobal: (s: string) => string;
  decryptGlobalSafe: (s: string, fallback: string) => { value: string; tampered: boolean };
  logAudit: (op: string) => void;
  checkExpectedVersion: (scope: string, cur: number, exp?: number) => void;
}
export function getIdentity(ctx: IdentityCtx): CoreIdentity & { version: number } { /* ... */ }
export function updateIdentity(ctx: IdentityCtx, identity: Partial<CoreIdentity>, expectedVersion?: number): number { /* ... */ }

// ledger/index.ts
export class Ledger {
  private db;
  private masterKey;
  private ctx: IdentityCtx & EventsCtx & /* ... */;
  constructor(...) {
    this.db = /* ... */;
    this.masterKey = /* ... */;
    this.ctx = {
      db: this.db,
      masterKey: this.masterKey,
      encryptGlobal: this.encryptGlobal.bind(this),
      // ...
    };
  }
  getIdentity() { return identityModule.getIdentity(this.ctx); }
  updateIdentity(id: Partial<CoreIdentity>, exp?: number) {
    return identityModule.updateIdentity(this.ctx, id, exp);
  }
  // ... repeat ~30 times
}
```

**Pros:**
- Cleanest type surface. Topic files have zero knowledge of the class.
- Topic files are trivially unit-testable in isolation (pass a fake ctx).
- No mutation of the class, no inheritance, no private-field gymnastics.

**Cons:**
- **Massive boilerplate.** Every public method on Ledger becomes a one-line delegation. The `ctx` object has to be constructed carefully to include every shared helper.
- Binding `this` for the ctx functions adds a memory footprint per Ledger instance (30+ bound closures).
- Test files that use `(ledger as any).db` still work, but a test that wants to call a topic function directly needs access to the ctx type.

**Verdict:** cleanest in theory, most churn in practice. Skip unless a future constraint (e.g., tree-shaking the server build to exclude unused topics) demands it.

---

## Recommended sequence

1. Adopt **Pattern A** (prototype augmentation + `declare module`).
2. Land `core.ts` first as its own commit — constructor, fields, `close`, `checkpoint`, `migrate`, all `encrypt*`/`decrypt*` helpers, tamper helpers, domain pseudonym glue, `channelIdHash`, `checkExpectedVersion`, static constants, the `generateULID` module-level function. Drop `private` on fields + cross-cutting helpers; add `@internal` JSDoc.
3. Run `npm test` — expect identical baseline to `main` (which matches `refactor/split-ledger` HEAD).
4. Land each topic file as its own commit. Order: `audit.ts` → `keys.ts` → `identity.ts` → `timeline.ts` → `events.ts` → `facts.ts`. Tests run green after each commit.
5. Finalize `index.ts` barrel with side-effect imports.
6. Final commit: delete the monolithic `ledger/index.ts` class body (the methods that have all been moved out), leaving only the barrel.

Budget estimate: one focused half-day session, ~6 commits, gated by per-commit test runs.

---

## Success criteria

- `ledger/` contains the seven files from the original spec plus `core.ts` and `helpers.ts`.
- Each topic file is 150-450 lines (rough balance).
- Public `Ledger` API byte-identical — same method names, same signatures, same return shapes.
- `tsc --noEmit` clean under strict mode.
- `npm test` shows the same pass/skip counts as `main` at HEAD. Zero behavior change.
- Existing `(ledger as any).db` test patterns still work (shared-field access is unchanged runtime-wise).

## What this branch does NOT do

Nothing, yet. This branch is a design-doc commit. Push this and stop. The next session picks up here.
