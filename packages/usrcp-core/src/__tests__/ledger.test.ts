import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as encryption from "../encryption.js";
import { Ledger } from "../ledger/index.js";
import { VersionConflictError } from "../types.js";
import { decrypt, deriveGlobalEncryptionKey, zeroBuffer } from "../encryption.js";

vi.mock("../encryption.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../encryption.js")>();
  return {
    ...actual,
    // commitKeyRotation is called by Ledger.rotateKey; mocking it lets us
    // simulate a Phase-3 disk-write failure without touching global fs state.
    commitKeyRotation: vi.fn(actual.commitKeyRotation),
  };
});

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `usrcp-test-${Date.now()}.db`);
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + "-wal");
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

describe("Core Identity", () => {
  it("returns default identity on fresh ledger", () => {
    const identity = ledger.getIdentity();
    expect(identity.display_name).toBe("");
    expect(identity.roles).toEqual([]);
    expect(identity.expertise_domains).toEqual([]);
    expect(identity.communication_style).toBe("concise");
  });

  it("updates identity fields", () => {
    ledger.updateIdentity({
      display_name: "Frank",
      roles: ["founder", "engineer"],
    });
    const identity = ledger.getIdentity();
    expect(identity.display_name).toBe("Frank");
    expect(identity.roles).toEqual(["founder", "engineer"]);
  });

  it("partially updates without overwriting other fields", () => {
    ledger.updateIdentity({ display_name: "Frank" });
    ledger.updateIdentity({ roles: ["founder"] });
    const identity = ledger.getIdentity();
    expect(identity.display_name).toBe("Frank");
    expect(identity.roles).toEqual(["founder"]);
  });

  it("updates expertise domains", () => {
    ledger.updateIdentity({
      expertise_domains: [
        { domain: "typescript", level: "expert" },
        { domain: "rust", level: "beginner" },
      ],
    });
    const identity = ledger.getIdentity();
    expect(identity.expertise_domains).toHaveLength(2);
    expect(identity.expertise_domains[0].domain).toBe("typescript");
  });
});

describe("Global Preferences", () => {
  it("returns defaults on fresh ledger", () => {
    const prefs = ledger.getPreferences();
    expect(prefs.language).toBe("en");
    expect(prefs.timezone).toBe("UTC");
    expect(prefs.output_format).toBe("markdown");
    expect(prefs.verbosity).toBe("standard");
    expect(prefs.custom).toEqual({});
  });

  it("updates preferences", () => {
    ledger.updatePreferences({
      timezone: "America/Los_Angeles",
      verbosity: "minimal",
    });
    const prefs = ledger.getPreferences();
    expect(prefs.timezone).toBe("America/Los_Angeles");
    expect(prefs.verbosity).toBe("minimal");
    expect(prefs.language).toBe("en"); // unchanged
  });

  it("merges custom preferences", () => {
    ledger.updatePreferences({ custom: { theme: "dark" } });
    ledger.updatePreferences({ custom: { editor: "vim" } });
    const prefs = ledger.getPreferences();
    expect(prefs.custom).toEqual({ theme: "dark", editor: "vim" });
  });
});

describe("Timeline Events", () => {
  it("appends an event and returns metadata", () => {
    const result = ledger.appendEvent(
      {
        domain: "coding",
        summary: "Fixed auth bug",
        intent: "Fix login issue",
        outcome: "success",
        tags: ["bugfix"],
      },
      "claude_code"
    );
    expect(result.event_id).toBeTruthy();
    expect(result.timestamp).toBeTruthy();
    expect(result.ledger_sequence).toBe(1);
  });

  it("increments ledger_sequence", () => {
    const r1 = ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i1", outcome: "success" },
      "claude_code"
    );
    const r2 = ledger.appendEvent(
      { domain: "coding", summary: "e2", intent: "i2", outcome: "success" },
      "claude_code"
    );
    expect(r2.ledger_sequence).toBe(r1.ledger_sequence + 1);
  });

  it("retrieves timeline in reverse chronological order", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "first", intent: "i", outcome: "success" },
      "p1"
    );
    ledger.appendEvent(
      { domain: "coding", summary: "second", intent: "i", outcome: "success" },
      "p1"
    );
    const timeline = ledger.getTimeline({ last_n: 10 });
    expect(timeline).toHaveLength(2);
    expect(timeline[0].summary).toBe("second");
    expect(timeline[1].summary).toBe("first");
  });

  it("filters timeline by domain", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "code", intent: "i", outcome: "success" },
      "p1"
    );
    ledger.appendEvent(
      {
        domain: "writing",
        summary: "write",
        intent: "i",
        outcome: "success",
      },
      "p1"
    );
    const timeline = ledger.getTimeline({ domains: ["coding"] });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].domain).toBe("coding");
  });

  it("limits timeline count", () => {
    for (let i = 0; i < 10; i++) {
      ledger.appendEvent(
        { domain: "coding", summary: `e${i}`, intent: "i", outcome: "success" },
        "p1"
      );
    }
    const timeline = ledger.getTimeline({ last_n: 3 });
    expect(timeline).toHaveLength(3);
  });

  it("stores and retrieves detail and artifacts", () => {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "deployed",
        intent: "ship",
        outcome: "success",
        detail: { language: "typescript", files: 3 },
        artifacts: [
          { type: "git_commit", ref: "https://github.com/x/y/commit/abc" },
        ],
      },
      "claude_code"
    );
    const timeline = ledger.getTimeline();
    expect(timeline[0].detail).toEqual({ language: "typescript", files: 3 });
    expect(timeline[0].artifacts).toHaveLength(1);
    expect(timeline[0].artifacts![0].type).toBe("git_commit");
  });
});

describe("Idempotency", () => {
  it("prevents duplicate writes with same idempotency key", () => {
    const r1 = ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i1", outcome: "success" },
      "p1",
      "idem_001"
    );
    const r2 = ledger.appendEvent(
      { domain: "coding", summary: "e2", intent: "i2", outcome: "success" },
      "p1",
      "idem_001"
    );
    expect(r2.event_id).toBe(r1.event_id);
    expect(r2.duplicate).toBe(true);
    expect(ledger.getTimeline()).toHaveLength(1);
  });

  it("allows different idempotency keys", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i1", outcome: "success" },
      "p1",
      "idem_001"
    );
    ledger.appendEvent(
      { domain: "coding", summary: "e2", intent: "i2", outcome: "success" },
      "p1",
      "idem_002"
    );
    expect(ledger.getTimeline()).toHaveLength(2);
  });

  it("allows writes without idempotency key", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i1", outcome: "success" },
      "p1"
    );
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i1", outcome: "success" },
      "p1"
    );
    expect(ledger.getTimeline()).toHaveLength(2);
  });
});

describe("Search", () => {
  beforeEach(() => {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Fixed authentication middleware",
        intent: "Fix auth",
        outcome: "success",
        tags: ["bugfix", "auth"],
      },
      "claude_code"
    );
    ledger.appendEvent(
      {
        domain: "writing",
        summary: "Wrote blog post about distributed systems",
        intent: "Create content",
        outcome: "success",
        tags: ["blog"],
      },
      "obsidian"
    );
  });

  it("searches by summary keyword", () => {
    const results = ledger.searchTimeline("authentication");
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe("coding");
  });

  it("searches by tag", () => {
    const results = ledger.searchTimeline("bugfix");
    expect(results).toHaveLength(1);
  });

  it("filters search by domain", () => {
    const results = ledger.searchTimeline("systems", { domain: "coding" });
    expect(results).toHaveLength(0);
  });

  it("limits search results", () => {
    for (let i = 0; i < 10; i++) {
      ledger.appendEvent(
        {
          domain: "coding",
          summary: `auth fix ${i}`,
          intent: "fix",
          outcome: "success",
        },
        "p1"
      );
    }
    const results = ledger.searchTimeline("auth", { limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe("Projects", () => {
  it("creates and retrieves a project", () => {
    ledger.upsertProject({
      project_id: "usrcp",
      name: "USRCP",
      domain: "coding",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "Building the protocol",
    });
    const projects = ledger.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("USRCP");
  });

  it("updates existing project on conflict", () => {
    ledger.upsertProject({
      project_id: "usrcp",
      name: "USRCP",
      domain: "coding",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "v1",
    });
    ledger.upsertProject({
      project_id: "usrcp",
      name: "USRCP",
      domain: "coding",
      status: "paused",
      last_touched: new Date().toISOString(),
      summary: "v2",
    });
    const projects = ledger.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].status).toBe("paused");
    expect(projects[0].summary).toBe("v2");
  });

  it("filters projects by status", () => {
    ledger.upsertProject({
      project_id: "p1",
      name: "Active",
      domain: "coding",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "",
    });
    ledger.upsertProject({
      project_id: "p2",
      name: "Done",
      domain: "coding",
      status: "completed",
      last_touched: new Date().toISOString(),
      summary: "",
    });
    const active = ledger.getProjects("active");
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("Active");
  });

  it("stores project_id as an opaque HMAC at rest but round-trips the caller's id", () => {
    const CANARY = "acme-divorce-case-CANARYzzq";
    ledger.upsertProject({
      project_id: CANARY,
      name: "Acme",
      domain: "legal",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "s",
    });

    // Caller gets exactly the id they passed back.
    expect(ledger.getProjects()[0].project_id).toBe(CANARY);

    // But nothing user-authored is stored in cleartext.
    const raw = (ledger as any).db
      .prepare("SELECT * FROM active_projects")
      .get() as any;
    expect(raw.project_id).not.toBe(CANARY);
    expect(raw.project_id).toMatch(/^[a-f0-9]{64}$/); // HMAC-SHA256 hex
    expect(raw.project_ref_enc).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain(CANARY);
  });

  it("migrates a legacy plaintext project_id on open", () => {
    const CANARY = "legacy-plaintext-CANARYzzq";
    ledger.upsertProject({
      project_id: CANARY,
      name: "L",
      domain: "coding",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "x",
    });
    // Revert to a pre-migration row: plaintext id, no project_ref_enc.
    (ledger as any).db
      .prepare("UPDATE active_projects SET project_id = ?, project_ref_enc = NULL")
      .run(CANARY);
    ledger.close();

    // Reopen → migrateData() re-keys the legacy row.
    ledger = new Ledger(dbPath);
    const raw = (ledger as any).db
      .prepare("SELECT * FROM active_projects")
      .get() as any;
    expect(raw.project_id).not.toBe(CANARY);
    expect(raw.project_id).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.project_ref_enc).toBeTruthy();
    expect(ledger.getProjects()[0].project_id).toBe(CANARY);
  });
});

describe("Domain Context", () => {
  it("stores and retrieves domain context", () => {
    ledger.upsertDomainContext("coding", {
      preferred_framework: "nextjs",
      css: "tailwind",
    });
    const ctx = ledger.getDomainContext(["coding"]);
    expect(ctx.coding).toEqual({
      preferred_framework: "nextjs",
      css: "tailwind",
    });
  });

  it("merges context on update", () => {
    ledger.upsertDomainContext("coding", { framework: "nextjs" });
    ledger.upsertDomainContext("coding", { css: "tailwind" });
    const ctx = ledger.getDomainContext(["coding"]);
    expect(ctx.coding).toEqual({ framework: "nextjs", css: "tailwind" });
  });

  it("returns all domains when no filter specified", () => {
    ledger.upsertDomainContext("coding", { lang: "ts" });
    ledger.upsertDomainContext("writing", { style: "technical" });
    const ctx = ledger.getDomainContext();
    expect(Object.keys(ctx)).toHaveLength(2);
    expect(ctx.coding.lang).toBe("ts");
    expect(ctx.writing.style).toBe("technical");
  });

  it("returns empty object for unknown domain", () => {
    const ctx = ledger.getDomainContext(["nonexistent"]);
    expect(ctx).toEqual({});
  });
});

describe("Composite State", () => {
  it("returns only requested scopes", () => {
    ledger.updateIdentity({ display_name: "Test" });
    const state = ledger.getState(["core_identity"]);
    expect(state.core_identity).toBeDefined();
    expect(state.global_preferences).toBeUndefined();
    expect(state.recent_timeline).toBeUndefined();
  });

  it("returns all scopes when all requested", () => {
    const state = ledger.getState([
      "core_identity",
      "global_preferences",
      "recent_timeline",
      "domain_context",
      "active_projects",
    ]);
    expect(state.core_identity).toBeDefined();
    expect(state.global_preferences).toBeDefined();
    expect(state.recent_timeline).toBeDefined();
    expect(state.domain_context).toBeDefined();
    expect(state.active_projects).toBeDefined();
  });
});

describe("Stats", () => {
  it("returns zeroes on empty ledger", () => {
    const stats = ledger.getStats();
    expect(stats.total_events).toBe(0);
    expect(stats.total_projects).toBe(0);
    expect(stats.domains).toEqual([]);
    expect(stats.platforms).toEqual([]);
  });

  it("tracks events and distinct domains/platforms", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "claude_code"
    );
    ledger.appendEvent(
      { domain: "writing", summary: "e2", intent: "i", outcome: "success" },
      "obsidian"
    );
    const stats = ledger.getStats();
    expect(stats.total_events).toBe(2);
    expect(stats.domains).toContain("coding");
    expect(stats.domains).toContain("writing");
    expect(stats.platforms).toContain("claude_code");
    expect(stats.platforms).toContain("obsidian");
  });
});

describe("Key Rotation", () => {
  it("re-encrypts all data and preserves functionality", () => {
    // Setup diverse data
    ledger.updateIdentity({ display_name: "Test User", roles: ["developer"] });
    ledger.updatePreferences({ timezone: "America/Chicago", verbosity: "verbose" });
    ledger.upsertProject({
      project_id: "test-project",
      name: "Test Project",
      domain: "coding",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "A test project for rotation",
    });
    ledger.upsertDomainContext("coding", { preferred_language: "typescript", framework: "next.js" });
    ledger.appendEvent({
      domain: "coding",
      summary: "Implemented rotation test",
      intent: "Test key rotation",
      outcome: "success",
      detail: { files: 5, lines: 200 },
      tags: ["test", "encryption"],
    }, "vitest");
    ledger.appendEvent({
      domain: "writing",
      summary: "Documented rotation process",
      intent: "Improve docs",
      outcome: "partial",
    }, "obsidian");

    const oldState = {
      identity: ledger.getIdentity(),
      prefs: ledger.getPreferences(),
      projects: ledger.getProjects(),
      timeline: ledger.getTimeline(),
      domains: ledger.getDomainContext(["coding", "writing"]),
    };

    const oldMaster = Buffer.from((ledger as any).masterKey);
    const oldEvents = ((ledger as any).db).prepare("SELECT domain FROM timeline_events").all() as any[];
    const oldPseudos = new Set<string>(oldEvents.map((e: any) => e.domain));

    const rotationResult = ledger.rotateKey();
    expect(rotationResult.version).toBeGreaterThan(0);
    expect(rotationResult.reencrypted).toBeGreaterThan(0);

    const newState = {
      identity: ledger.getIdentity(),
      prefs: ledger.getPreferences(),
      projects: ledger.getProjects(),
      timeline: ledger.getTimeline(),
      domains: ledger.getDomainContext(["coding", "writing"]),
    };

    // Verify data preserved (ignore tampered flags)
    expect(newState.identity.display_name).toBe(oldState.identity.display_name);
    expect(newState.identity.roles).toEqual(oldState.identity.roles);
    expect(newState.prefs.timezone).toBe(oldState.prefs.timezone);
    expect(newState.projects[0].name).toBe(oldState.projects[0].name);
    // getTimeline returns newest-first, so the writing event (appended second)
    // is at [0] and the coding event (appended first) is at [1].
    expect(newState.timeline[1].summary).toBe("Implemented rotation test");
    expect(newState.timeline[0].domain).toBe("writing");
    expect(newState.domains.coding.preferred_language).toBe("typescript");

    // Pseudonyms re-derived (changed) — oldPseudos captured before rotation.
    const newEvents = ((ledger as any).db).prepare("SELECT domain FROM timeline_events").all() as any[];
    const newPseudos = new Set<string>(newEvents.map((e: any) => e.domain));
    expect([...oldPseudos].every((p) => !newPseudos.has(p))).toBe(true);

    // Old key cannot decrypt new data
    const rawProject = ((ledger as any).db).prepare("SELECT name FROM active_projects LIMIT 1").get() as any;
    const oldGlobalKey = deriveGlobalEncryptionKey(oldMaster);
    expect(() => decrypt(rawProject.name, oldGlobalKey)).toThrow();
    zeroBuffer(oldGlobalKey);
    zeroBuffer(oldMaster);
  });

  it("recovers from file write failure during commit", () => {
    ledger.updateIdentity({ display_name: "Recovery Test" });

    // Phase 2 (the transaction) commits pending_key before Phase 3 writes
    // key files. Forcing Phase 3's commitKeyRotation to fail leaves the
    // rotation in the "interrupted" state that the recovery path handles.
    vi.mocked(encryption.commitKeyRotation).mockImplementationOnce(() => {
      throw new Error("disk failure");
    });

    expect(() => ledger.rotateKey()).toThrow("disk failure");

    // Create new ledger instance — should detect pending_key and recover.
    const recoveredLedger = new Ledger(dbPath);
    const recoveredState = recoveredLedger.getIdentity();
    expect(recoveredState.display_name).toBe("Recovery Test");
    // Recovery clears pending_key.
    const rotation = (recoveredLedger as any).db.prepare("SELECT pending_key FROM rotation_state").get() as any;
    expect(rotation.pending_key).toBe(null);
    recoveredLedger.close();
  });

  it("recovers a passphrase-mode rotation that crashed between DB commit and commitKeyRotation (Codex P1 on PR #72)", async () => {
    // The Codex P1: in passphrase mode, if the DB transaction commits
    // pending_key but the process dies before commitKeyRotation
    // writes the new master.salt / master.verify / mode files, the
    // canonical key-file set still derives the OLD master key.
    // initializeMasterKey on next boot prioritizes mode="passphrase"
    // and ignores any recovered master.key. Result pre-PR-#72-followup:
    // DB encrypted under NEW key, files derive OLD key, no
    // pending_key checkpoint -> bricked.
    //
    // Fix: rotation_state.pending_files_json now stores the full
    // target file set inside the same DB transaction as pending_key,
    // and recovery replays it via commitKeyRotation.

    // Build a fresh passphrase-mode Ledger in an isolated HOME so the
    // canonical key files write to a tmp dir, not the developer's
    // real ~/.usrcp.
    const origHome = process.env.HOME;
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-passphrase-recover-"));
    process.env.HOME = isoHome;
    try {
      const isoDbPath = path.join(isoHome, "ledger.db");
      const isoLedger = new Ledger(isoDbPath, "alice-original-passphrase");
      isoLedger.updateIdentity({ display_name: "Passphrase Recovery Test" });

      // Force commitKeyRotation to fail AFTER the DB transaction
      // commits but BEFORE the key files land on disk.
      vi.mocked(encryption.commitKeyRotation).mockImplementationOnce(() => {
        throw new Error("simulated disk failure mid-rotation");
      });
      expect(() => isoLedger.rotateKey("bob-new-passphrase")).toThrow(
        /simulated disk failure mid-rotation/
      );
      // Restore the real commitKeyRotation so recovery (which is what
      // we're testing) gets the unmocked implementation.
      const { commitKeyRotation: realCommit } =
        await vi.importActual<typeof import("../encryption.js")>("../encryption.js");
      vi.mocked(encryption.commitKeyRotation).mockImplementation(realCommit);

      isoLedger.close();

      // Reopen with the NEW passphrase. If recovery worked, the
      // canonical master.salt + master.verify now derive the NEW key
      // and the Ledger constructor finishes cleanly. Display name
      // round-trips because the DB rows are decryptable under the
      // recovered key.
      const recovered = new Ledger(isoDbPath, "bob-new-passphrase");
      try {
        expect(recovered.getIdentity().display_name).toBe("Passphrase Recovery Test");
        const rotation = (recovered as any).db
          .prepare("SELECT pending_key, pending_files_json FROM rotation_state")
          .get() as any;
        expect(rotation.pending_key).toBe(null);
        expect(rotation.pending_files_json).toBe(null);
      } finally {
        recovered.close();
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(isoHome, { recursive: true, force: true }); } catch {}
    }
  });

  it("re-encrypts private.pem under the new master key so getDecryptedPrivateKeyPem still works after rotate (PR #73)", async () => {
    // Pre-PR-#73 latent bug: rotateKey rotated the DB and the
    // master-key file set but never touched private.pem. The Ed25519
    // identity key stayed sealed under the OLD globalKey, and any
    // post-rotation call to getDecryptedPrivateKeyPem would throw a
    // GCM auth-tag mismatch - effectively orphaning the identity
    // used for cloud-sync signing.
    //
    // Fix: prepareReencryptedPrivatePem builds a re-keyed entry that
    // gets appended to pendingFiles, so the new private.pem is
    // written by commitKeyRotation alongside master.salt/verify/mode
    // AND captured in rotation_state.pending_files_json for crash
    // recovery.
    //
    // Isolated HOME so the test doesn't interact with the developer's
    // real ~/.usrcp - critical here because prior tests in this suite
    // may have left private.pem sealed under a stale key from rotateKey
    // calls that didn't have this fix.
    const origHome = process.env.HOME;
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pem-rotate-"));
    process.env.HOME = isoHome;
    try {
      const isoDbPath = path.join(isoHome, "ledger.db");
      const isoLedger = new Ledger(isoDbPath, "alice-passphrase");
      const { getDecryptedPrivateKeyPem } = await import("../crypto.js");
      const pemBefore = getDecryptedPrivateKeyPem((isoLedger as any).masterKey);
      expect(pemBefore).toContain("BEGIN PRIVATE KEY");

      isoLedger.rotateKey("bob-passphrase");

      // After rotation, the in-memory masterKey is the NEW key. The
      // private.pem on disk MUST be decryptable under it.
      const pemAfter = getDecryptedPrivateKeyPem((isoLedger as any).masterKey);
      expect(pemAfter).toBe(pemBefore);
      isoLedger.close();

      // Sanity-check via a fresh constructor too: reopening with the
      // new passphrase should let getDecryptedPrivateKeyPem succeed
      // without round-tripping in-memory state.
      const reopened = new Ledger(isoDbPath, "bob-passphrase");
      try {
        const pemAfterReopen = getDecryptedPrivateKeyPem((reopened as any).masterKey);
        expect(pemAfterReopen).toBe(pemBefore);
      } finally {
        reopened.close();
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(isoHome, { recursive: true, force: true }); } catch {}
    }
  });

  it("reopens a ledger with events but an empty blind_index (Codex P1 on PR #72 round-2)", async () => {
    // Codex round-2 P1 surfaced this: PR #72 moved migrate() ahead
    // of initializeMasterKey so rotation_state.pending_files_json
    // is queryable for the pre-init recovery probe. But migrate()
    // historically also contained the blind-index rebuild for
    // legacy DBs that have events but no blind_index rows, and
    // that rebuild decrypts event fields via this.masterKey -
    // which is not yet assigned at migrate() time. Moving
    // migrate() up would have called rebuildBlindIndex() against
    // an undefined masterKey and crashed.
    //
    // Fix: split the schema migration from the data-rebuild step
    // (migrateData), and call migrateData AFTER initializeMasterKey
    // + post-init recovery installs the final masterKey.
    const origHome = process.env.HOME;
    const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-blind-rebuild-"));
    process.env.HOME = isoHome;
    try {
      const isoDbPath = path.join(isoHome, "ledger.db");
      // Step 1: create a ledger and add events (this populates
      // blind_index via the normal append path).
      const seed = new Ledger(isoDbPath, "test-passphrase");
      seed.appendEvent(
        {
          domain: "test",
          summary: "needs blind-index entries",
          intent: "exercise the rebuild path",
          outcome: "success",
        },
        "test"
      );
      seed.close();

      // Step 2: open the DB directly and wipe blind_index, simulating
      // a legacy ledger that has events but no blind tokens.
      const Database = (await import("better-sqlite3")).default;
      const raw = new Database(isoDbPath);
      raw.prepare("DELETE FROM blind_index").run();
      raw.close();

      // Step 3: reopen via the Ledger constructor. The new ordering
      // must NOT call rebuildBlindIndex before initializeMasterKey
      // sets this.masterKey. After this constructor returns, the
      // blind_index should be repopulated.
      const reopened = new Ledger(isoDbPath, "test-passphrase");
      try {
        const blindCount = (reopened as any).db
          .prepare("SELECT COUNT(*) as c FROM blind_index")
          .get() as any;
        expect(blindCount.c).toBeGreaterThan(0);
      } finally {
        reopened.close();
      }
    } finally {
      process.env.HOME = origHome;
      try { fs.rmSync(isoHome, { recursive: true, force: true }); } catch {}
    }
  });

  it("invokes onKeysReady with both keys after commit, before in-memory swap", () => {
    let observed: { oldKey: Buffer; newKey: Buffer; oldSameAsCurrent: boolean } | null = null;

    const currentBefore = Buffer.from((ledger as any).masterKey);

    ledger.rotateKey(undefined, {
      onKeysReady: (oldKey, newKey) => {
        // Capture state from inside the hook: oldKey must still match
        // the ledger's current masterKey buffer (the swap happens
        // AFTER the hook so adapter re-encryption can decrypt with
        // the old key it knows about). newKey is the rotation target.
        observed = {
          oldKey: Buffer.from(oldKey),
          newKey: Buffer.from(newKey),
          oldSameAsCurrent: Buffer.compare(oldKey, (ledger as any).masterKey) === 0,
        };
      },
    });

    expect(observed).not.toBeNull();
    expect(observed!.oldKey.length).toBe(32);
    expect(observed!.newKey.length).toBe(32);
    expect(Buffer.compare(observed!.oldKey, currentBefore)).toBe(0);
    expect(observed!.oldSameAsCurrent).toBe(true);

    // After rotateKey returns, the in-memory key is the new one.
    expect(Buffer.compare((ledger as any).masterKey, observed!.newKey)).toBe(0);
  });

  it("treats onKeysReady throw as non-fatal (rotation still completes)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      ledger.rotateKey(undefined, {
        onKeysReady: () => {
          throw new Error("simulated adapter re-encryption blew up");
        },
      }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("simulated adapter re-encryption blew up"),
    );

    // pending_key should still be cleared (rotation considered complete).
    const rotation = (ledger as any).db
      .prepare("SELECT pending_key FROM rotation_state")
      .get() as any;
    expect(rotation.pending_key).toBe(null);

    warnSpy.mockRestore();
  });

  it("resets tamper counter after rotation", () => {
    // Simulate tampers to set count > 0
    for (let i = 0; i < 3; i++) {
      ledger.appendEvent({
        domain: "test",
        summary: `tamper event ${i}`,
        intent: "test",
        outcome: "success",
      }, "test");
      const event = ledger.getTimeline({ last_n: 1 })[0];
      const row = ((ledger as any).db).prepare("SELECT summary FROM timeline_events WHERE event_id = ?").get(event.event_id) as any;
      const parts = row.summary.split(":");
      const buf = Buffer.from(parts[1], "base64");
      buf[buf.length - 16] ^= 0xff;
      const tampered = "enc:" + buf.toString("base64");
      ((ledger as any).db).prepare("UPDATE timeline_events SET summary = ? WHERE event_id = ?").run(tampered, event.event_id);
      ledger.getTimeline({ last_n: 1 }); // trigger tamper
    }

    const preState = ledger.getState(["global_preferences"]);
    const preTracker = (preState.global_preferences as any).custom.tamperTracker as any;
    expect(preTracker.count).toBe(3);

    // v0.1.5: rotation refuses to proceed past damaged rows by default.
    // This test plants damaged rows on purpose to assert the
    // tamper-tracker reset; opt in via force_skip_damaged.
    ledger.rotateKey(undefined, { force_skip_damaged: true });

    const postState = ledger.getState(["global_preferences"]);
    const postTracker = (postState.global_preferences as any).custom.tamperTracker as any;
    expect(postTracker.count).toBe(0);
    expect(postTracker.lastTamper).toBe(null);
  });
});

describe("Schemaless Facts", () => {
  it("write/read roundtrip for a single fact", () => {
    const res = ledger.setFact("personal", "habits", "morning_routine", {
      wake: "06:30",
      steps: ["water", "meditate", "run"],
    });
    expect(res.created).toBe(true);
    expect(res.fact_id).toMatch(/^[0-9A-Z]{26}$/);

    const fact = ledger.getFact("personal", "habits", "morning_routine");
    expect(fact).not.toBeNull();
    expect(fact!.namespace).toBe("habits");
    expect(fact!.key).toBe("morning_routine");
    expect(fact!.domain).toBe("personal");
    expect(fact!.value).toEqual({ wake: "06:30", steps: ["water", "meditate", "run"] });
  });

  it("upserts on repeat write with same (domain, namespace, key)", () => {
    const first = ledger.setFact("personal", "habits", "sleep", { hours: 7 });
    expect(first.created).toBe(true);

    const second = ledger.setFact("personal", "habits", "sleep", { hours: 8 });
    expect(second.created).toBe(false);
    expect(second.fact_id).toBe(first.fact_id);

    const fact = ledger.getFact("personal", "habits", "sleep");
    expect((fact!.value as any).hours).toBe(8);
  });

  it("distinguishes facts across namespaces with same key", () => {
    ledger.setFact("personal", "habits", "morning", "a");
    ledger.setFact("personal", "goals", "morning", "b");
    expect(ledger.getFact("personal", "habits", "morning")!.value).toBe("a");
    expect(ledger.getFact("personal", "goals", "morning")!.value).toBe("b");
  });

  it("lists all facts in a domain", () => {
    ledger.setFact("personal", "habits", "a", 1);
    ledger.setFact("personal", "habits", "b", 2);
    ledger.setFact("personal", "goals", "c", 3);

    const all = ledger.listFacts("personal");
    expect(all.length).toBe(3);

    const habits = ledger.listFacts("personal", "habits");
    expect(habits.length).toBe(2);
    expect(habits.map((f) => f.key).sort()).toEqual(["a", "b"]);
  });

  it("deletes facts by fact_id", () => {
    const { fact_id } = ledger.setFact("personal", "goals", "x", 1);
    expect(ledger.deleteFact(fact_id)).toBe(true);
    expect(ledger.getFact("personal", "goals", "x")).toBeNull();
    expect(ledger.deleteFact(fact_id)).toBe(false);
  });

  it("domain isolation: ns_key_hash differs across domains for same (ns, key)", () => {
    ledger.setFact("work", "secrets", "totp", "A");
    ledger.setFact("personal", "secrets", "totp", "B");

    const row = (ledger as any).db
      .prepare("SELECT domain, ns_key_hash FROM schemaless_facts")
      .all() as any[];
    expect(row.length).toBe(2);
    expect(row[0].domain).not.toBe(row[1].domain);
    expect(row[0].ns_key_hash).not.toBe(row[1].ns_key_hash);

    expect((ledger.getFact("work", "secrets", "totp")!.value as string)).toBe("A");
    expect((ledger.getFact("personal", "secrets", "totp")!.value as string)).toBe("B");
  });

  it("encrypts namespace, key, and value at rest", () => {
    ledger.setFact("coding", "frameworks", "frontend", "nextjs");
    const row = (ledger as any).db
      .prepare("SELECT namespace, \"key\", value FROM schemaless_facts")
      .get() as any;
    expect(row.namespace.startsWith("enc:")).toBe(true);
    expect(row.key.startsWith("enc:")).toBe(true);
    expect(row.value.startsWith("enc:")).toBe(true);
  });

  it("rejects empty namespace or key", () => {
    expect(() => ledger.setFact("personal", "", "foo", 1)).toThrow(/namespace/);
    expect(() => ledger.setFact("personal", "ns", "", 1)).toThrow(/key/);
  });

  it("rejects oversized value", () => {
    const huge = "x".repeat(65537);
    expect(() => ledger.setFact("personal", "ns", "k", huge)).toThrow(/value exceeds/);
  });

  it("tracks version and increments on update", () => {
    const first = ledger.setFact("personal", "habits", "run", { km: 5 });
    expect(first.version).toBe(1);
    const second = ledger.setFact("personal", "habits", "run", { km: 6 });
    expect(second.version).toBe(2);
    expect(ledger.getFact("personal", "habits", "run")!.version).toBe(2);
  });

  it("expected_version match succeeds and bumps version", () => {
    const created = ledger.setFact("personal", "goals", "x", 1);
    const updated = ledger.setFact("personal", "goals", "x", 2, { expectedVersion: created.version });
    expect(updated.version).toBe(created.version + 1);
  });

  it("expected_version mismatch throws VERSION_CONFLICT", () => {
    ledger.setFact("personal", "goals", "x", 1); // version = 1
    ledger.setFact("personal", "goals", "x", 2); // version = 2
    expect(() =>
      ledger.setFact("personal", "goals", "x", 3, { expectedVersion: 1 })
    ).toThrow(VersionConflictError);
  });

  it("expected_version=0 succeeds only for new facts", () => {
    const res = ledger.setFact("personal", "new", "fresh", 1, { expectedVersion: 0 });
    expect(res.created).toBe(true);
    expect(res.version).toBe(1);
    // A second call with expected=0 must fail (fact now exists)
    expect(() =>
      ledger.setFact("personal", "new", "fresh", 2, { expectedVersion: 0 })
    ).toThrow(VersionConflictError);
  });

  it("key rotation preserves all facts with re-derived ns_key_hash", () => {
    ledger.setFact("personal", "habits", "morning", { wake: "06:30" });
    ledger.setFact("personal", "goals", "q1", { target: "ship v1" });
    ledger.setFact("work", "secrets", "api", "rotate-me");

    const beforeRows = (ledger as any).db
      .prepare("SELECT fact_id, ns_key_hash FROM schemaless_facts ORDER BY fact_id")
      .all() as any[];

    ledger.rotateKey();

    const afterRows = (ledger as any).db
      .prepare("SELECT fact_id, ns_key_hash FROM schemaless_facts ORDER BY fact_id")
      .all() as any[];

    expect(afterRows.length).toBe(beforeRows.length);
    // ns_key_hash must change because blind-index key is re-derived
    for (let i = 0; i < beforeRows.length; i++) {
      expect(afterRows[i].fact_id).toBe(beforeRows[i].fact_id);
      expect(afterRows[i].ns_key_hash).not.toBe(beforeRows[i].ns_key_hash);
    }

    // Reads still work — lookup uses new key, matches new hash
    expect((ledger.getFact("personal", "habits", "morning")!.value as any).wake).toBe("06:30");
    expect((ledger.getFact("personal", "goals", "q1")!.value as any).target).toBe("ship v1");
    expect(ledger.getFact("work", "secrets", "api")!.value).toBe("rotate-me");
  });
});

describe("Optimistic Concurrency (v0.2.0)", () => {
  it("identity starts at version 1 and bumps on update", () => {
    expect(ledger.getIdentity().version).toBe(1);
    const v = ledger.updateIdentity({ display_name: "Frank" });
    expect(v).toBe(2);
    expect(ledger.getIdentity().version).toBe(2);
    ledger.updateIdentity({ display_name: "Frank B" });
    expect(ledger.getIdentity().version).toBe(3);
  });

  it("identity expected_version match succeeds", () => {
    const v = ledger.getIdentity().version;
    const newV = ledger.updateIdentity({ display_name: "Frank" }, v);
    expect(newV).toBe(v + 1);
  });

  it("identity expected_version mismatch throws VERSION_CONFLICT", () => {
    const v = ledger.getIdentity().version;
    ledger.updateIdentity({ display_name: "someone-else" }); // bumps version
    expect(() => ledger.updateIdentity({ display_name: "Frank" }, v)).toThrow(VersionConflictError);

    try {
      ledger.updateIdentity({ display_name: "Frank" }, v);
    } catch (err: any) {
      expect(err.code).toBe("VERSION_CONFLICT");
      expect(err.scope).toBe("core_identity");
      expect(err.expectedVersion).toBe(v);
      expect(err.currentVersion).toBe(v + 1);
    }
  });

  it("preferences tracks version independently from identity", () => {
    const idV = ledger.getIdentity().version;
    ledger.updatePreferences({ verbosity: "minimal" });
    expect(ledger.getPreferences().version).toBeGreaterThan(1);
    expect(ledger.getIdentity().version).toBe(idV); // unchanged
  });

  it("preferences expected_version mismatch throws VERSION_CONFLICT", () => {
    const v = ledger.getPreferences().version;
    ledger.updatePreferences({ timezone: "Europe/Berlin" });
    expect(() => ledger.updatePreferences({ timezone: "Asia/Tokyo" }, v)).toThrow(VersionConflictError);
  });

  it("domain_context version is 0 before first write, 1 after first write", () => {
    expect(ledger.getDomainContextVersion("coding")).toBe(0);
    ledger.upsertDomainContext("coding", { framework: "nextjs" });
    expect(ledger.getDomainContextVersion("coding")).toBe(1);
  });

  it("domain_context expected_version=0 succeeds on first write, mismatches on second", () => {
    ledger.upsertDomainContext("coding", { framework: "nextjs" }, 0);
    // Now version=1. Caller using expected=0 must fail
    expect(() =>
      ledger.upsertDomainContext("coding", { framework: "remix" }, 0)
    ).toThrow(VersionConflictError);
  });

  it("domain_context versions are independent per-domain", () => {
    ledger.upsertDomainContext("coding", { x: 1 });
    ledger.upsertDomainContext("coding", { x: 2 });
    ledger.upsertDomainContext("writing", { y: 1 });
    expect(ledger.getDomainContextVersion("coding")).toBe(2);
    expect(ledger.getDomainContextVersion("writing")).toBe(1);
  });

  it("concurrent preference writes converge without data corruption", () => {
    // Two writers racing — last write wins, no partial write, no crash
    for (let i = 0; i < 50; i++) {
      ledger.updatePreferences({ timezone: "A" });
      ledger.updatePreferences({ timezone: "B" });
    }
    const prefs = ledger.getPreferences();
    expect(["A", "B"]).toContain(prefs.timezone);
    expect(prefs.version).toBeGreaterThan(100);
  });

  it("concurrent timeline writes all land (append-only, no conflict)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { event_id } = ledger.appendEvent(
        { domain: "coding", summary: `e${i}`, intent: "test", outcome: "success" },
        "test"
      );
      ids.add(event_id);
    }
    expect(ids.size).toBe(20);
    const timeline = ledger.getTimeline({ last_n: 100 });
    expect(timeline.length).toBe(20);
    // Every ledger_sequence is distinct and monotonic
    const seqs = (ledger as any).db
      .prepare("SELECT ledger_sequence FROM timeline_events ORDER BY ledger_sequence")
      .all()
      .map((r: any) => r.ledger_sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});
