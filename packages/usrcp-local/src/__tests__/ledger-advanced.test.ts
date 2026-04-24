import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as encryption from "../encryption.js";
import { Ledger } from "../ledger/index.js";

vi.mock("../encryption.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../encryption.js")>();
  return {
    ...actual,
    // commitKeyRotation runs in Phase 3 of rotateKey (disk write after the DB
    // transaction commits). Mocking it lets tests simulate a disk-write
    // failure without chmod'ing real filesystem paths.
    commitKeyRotation: vi.fn(actual.commitKeyRotation),
  };
});

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `usrcp-adv-test-${Date.now()}.db`);
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

describe("ULID generation", () => {
  it("generates 26-character Crockford Base32 ULIDs", () => {
    const result = ledger.appendEvent(
      { domain: "test", summary: "t", intent: "t", outcome: "success" },
      "test"
    );
    expect(result.event_id).toHaveLength(26);
    // Crockford Base32 excludes I, L, O, U
    expect(result.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates monotonically increasing ULIDs", () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = ledger.appendEvent(
        { domain: "test", summary: `e${i}`, intent: "t", outcome: "success" },
        "test"
      );
      ids.push(result.event_id);
    }
    // ULIDs should be lexicographically sortable
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("generates unique ULIDs even within same millisecond", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = ledger.appendEvent(
        { domain: "test", summary: `e${i}`, intent: "t", outcome: "success" },
        "test"
      );
      ids.add(result.event_id);
    }
    expect(ids.size).toBe(100);
  });
});

describe("FTS5 full-text search", () => {
  beforeEach(() => {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Refactored authentication middleware to use JWT tokens",
        intent: "Improve security",
        outcome: "success",
        tags: ["security", "auth", "refactor"],
      },
      "claude_code"
    );
    ledger.appendEvent(
      {
        domain: "writing",
        summary: "Wrote blog post about distributed consensus algorithms",
        intent: "Create educational content",
        outcome: "success",
        tags: ["blog", "distributed-systems"],
      },
      "obsidian"
    );
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Fixed authentication bug in login flow",
        intent: "Fix critical bug",
        outcome: "success",
        tags: ["bugfix", "auth"],
      },
      "cursor"
    );
  });

  it("finds events by keyword with ranking", () => {
    const results = ledger.searchTimeline("authentication");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both auth events should be found
    const summaries = results.map((e) => e.summary);
    expect(summaries.some((s) => s.includes("Refactored"))).toBe(true);
    expect(summaries.some((s) => s.includes("Fixed"))).toBe(true);
  });

  it("supports prefix matching", () => {
    const results = ledger.searchTimeline("auth");
    // "auth" should match "authentication" via prefix
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by domain", () => {
    const results = ledger.searchTimeline("auth", { domain: "coding" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    results.forEach((e) => expect(e.domain).toBe("coding"));
  });

  it("limits results", () => {
    const results = ledger.searchTimeline("auth", { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("returns empty for no matches", () => {
    const results = ledger.searchTimeline("xyznonexistent");
    expect(results).toHaveLength(0);
  });

  it("handles special characters in query without crashing", () => {
    // FTS5 special chars like * + - should be sanitized
    const results = ledger.searchTimeline("auth + bug*");
    // Should not throw, may return results based on sanitized query
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("Event pruning and compaction", () => {
  it("compacts old events by stripping detail and artifacts", () => {
    // Insert an event with a backdated timestamp
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60); // 60 days ago

    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Old event with detail",
        intent: "test",
        outcome: "success",
        detail: { files: ["a.ts", "b.ts"], language: "typescript" },
        artifacts: [{ type: "git_commit", ref: "https://github.com/x/y/commit/abc" }],
      },
      "test"
    );

    // Manually backdate the event
    const event = ledger.getTimeline({ last_n: 1 })[0];
    // Use raw SQL to backdate
    (ledger as any).db
      .prepare("UPDATE timeline_events SET timestamp = ? WHERE event_id = ?")
      .run(oldDate.toISOString(), event.event_id);

    const result = ledger.pruneOldEvents(30);
    expect(result.compacted).toBe(1);

    // Verify detail and artifacts are stripped
    const pruned = ledger.getTimeline({ last_n: 1 })[0];
    expect(pruned.summary).toBe("Old event with detail"); // Summary preserved
    expect(pruned.detail).toEqual({}); // Detail stripped
    expect(pruned.artifacts).toEqual([]); // Artifacts stripped
  });

  it("does not compact recent events", () => {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Recent event",
        intent: "test",
        outcome: "success",
        detail: { important: true },
      },
      "test"
    );

    const result = ledger.pruneOldEvents(30);
    expect(result.compacted).toBe(0);

    const event = ledger.getTimeline({ last_n: 1 })[0];
    expect(event.detail).toEqual({ important: true });
  });

  it("deletes events older than threshold", () => {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: "Will be deleted",
        intent: "test",
        outcome: "success",
      },
      "test"
    );

    const event = ledger.getTimeline({ last_n: 1 })[0];
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    (ledger as any).db
      .prepare("UPDATE timeline_events SET timestamp = ? WHERE event_id = ?")
      .run(oldDate.toISOString(), event.event_id);

    const deleted = ledger.deleteOldEvents(90);
    expect(deleted).toBe(1);
    expect(ledger.getTimeline()).toHaveLength(0);
  });
});

describe("Database stats", () => {
  it("includes db_size_bytes", () => {
    const stats = ledger.getStats();
    expect(stats.db_size_bytes).toBeGreaterThan(0);
  });
});

describe("WAL checkpoint", () => {
  it("checkpoints without error", () => {
    ledger.appendEvent(
      { domain: "test", summary: "t", intent: "t", outcome: "success" },
      "test"
    );
    expect(() => ledger.checkpoint()).not.toThrow();
  });

  it("vacuum compacts the database", () => {
    // Insert and delete some events to create fragmentation
    for (let i = 0; i < 10; i++) {
      ledger.appendEvent(
        { domain: "test", summary: `e${i}`, intent: "t", outcome: "success" },
        "test"
      );
    }
    expect(() => ledger.checkpoint(true)).not.toThrow();
  });
});

describe("Graceful close", () => {
  it("close is idempotent", () => {
    ledger.close();
    expect(() => ledger.close()).not.toThrow();
  });
});

describe("Safe JSON parsing", () => {
  it("survives corrupted JSON in database records", () => {
    // Insert a valid event
    ledger.appendEvent(
      { domain: "test", summary: "t", intent: "t", outcome: "success" },
      "test"
    );

    // Corrupt the detail field directly
    const event = ledger.getTimeline({ last_n: 1 })[0];
    (ledger as any).db
      .prepare(
        "UPDATE timeline_events SET detail = '{invalid json}' WHERE event_id = ?"
      )
      .run(event.event_id);

    // Should NOT crash — returns fallback
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({});
  });

  it("survives corrupted tags JSON", () => {
    ledger.appendEvent(
      { domain: "test", summary: "t", intent: "t", outcome: "success" },
      "test"
    );

    const event = ledger.getTimeline({ last_n: 1 })[0];
    (ledger as any).db
      .prepare(
        "UPDATE timeline_events SET tags = 'not-json' WHERE event_id = ?"
      )
      .run(event.event_id);

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].tags).toEqual([]);
  });

  it("survives corrupted identity roles", () => {
    (ledger as any).db
      .prepare("UPDATE core_identity SET roles = 'broken' WHERE id = 1")
      .run();

    const identity = ledger.getIdentity();
    expect(identity.roles).toEqual([]);
  });

  it("survives corrupted domain context", () => {
    // First create a real domain context so domain_map exists
    ledger.upsertDomainContext("test", { key: "value" });
    // Then corrupt it directly
    const pseudo = (ledger as any).domainPseudonym("test");
    (ledger as any).db
      .prepare("UPDATE domain_context SET context = 'nope' WHERE domain = ?")
      .run(pseudo);

    const ctx = ledger.getDomainContext(["test"]);
    expect(ctx.test).toEqual({});
  });
});

describe("Advanced Key Rotation", () => {
  it("recovers from disk-write failure during rotation commit", async () => {
    // After the DB transaction commits (pending_key stored), Phase 3 writes
    // the new key files to disk. If that write fails, the ledger must be
    // recoverable on the next open by reading pending_key from rotation_state.
    const { commitKeyRotation: realCommit } =
      await vi.importActual<typeof import("../encryption.js")>("../encryption.js");

    ledger.updateIdentity({ display_name: "DiskFailTest" });
    ledger.appendEvent({
      domain: "test",
      summary: "event",
      intent: "test",
      outcome: "success",
    }, "test");

    const commitMock = vi.mocked(encryption.commitKeyRotation);
    commitMock.mockImplementationOnce(() => {
      throw new Error("simulated disk-write failure");
    });

    expect(() => ledger.rotateKey()).toThrow(/simulated disk-write failure/);

    // Restore the real implementation so the recovery path can write keys.
    commitMock.mockImplementation(realCommit);

    // Reopen — constructor detects pending_key and completes the key write.
    ledger.close();
    const recovered = new Ledger(dbPath);
    expect(recovered.getIdentity().display_name).toBe("DiskFailTest");
    const rotation = ((recovered as any).db)
      .prepare("SELECT pending_key FROM rotation_state")
      .get() as any;
    expect(rotation.pending_key).toBe(null);
    recovered.close();
    // Rebind `ledger` to the recovered instance so afterEach can close it
    // cleanly (close is idempotent — the original was already closed).
    ledger = new Ledger(dbPath);
  });

  it("skips tampered rows and completes rotation", () => {
    // Tampered rows are no longer cause to abort rotation. They are left
    // in place under their old pseudonym / old ciphertext, reported in the
    // `skipped` count, and stay unreadable under the new key.
    ledger.appendEvent({
      domain: "test",
      summary: "good event",
      intent: "t",
      outcome: "success",
    }, "test");
    ledger.appendEvent({
      domain: "test",
      summary: "bad event",
      intent: "t",
      outcome: "success",
    }, "test");

    const target = ledger.getTimeline({ last_n: 1 })[0];
    const raw = ((ledger as any).db)
      .prepare("SELECT summary FROM timeline_events WHERE event_id = ?")
      .get(target.event_id) as any;
    const parts = raw.summary.split(":");
    const buf = Buffer.from(parts[1], "base64");
    buf[buf.length - 16] ^= 0xff;
    const corrupted = "enc:" + buf.toString("base64");
    ((ledger as any).db)
      .prepare("UPDATE timeline_events SET summary = ? WHERE event_id = ?")
      .run(corrupted, target.event_id);

    const result = ledger.rotateKey();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.reencrypted).toBeGreaterThanOrEqual(1);

    // Good event survived rotation and decrypts cleanly under the new key.
    const remaining = ledger.getTimeline();
    expect(remaining.map((e) => e.summary)).toContain("good event");
    // Tampered row stays in the table for auditability; it surfaces with a
    // tampered marker rather than being silently dropped.
    const stillThere = ((ledger as any).db)
      .prepare("SELECT event_id FROM timeline_events WHERE event_id = ?")
      .get(target.event_id) as any;
    expect(stillThere).toBeDefined();
  });

  it("handles rotation with mixed encrypted/unencrypted legacy data", () => {
    // Simulate legacy unencrypted data
    const pseudo = (ledger as any).domainPseudonym("legacy");
    (ledger as any).db.prepare("INSERT INTO domain_context (domain, context) VALUES (?, ?)")
      .run(pseudo, "legacy plaintext context"); // no enc:

    ledger.appendEvent({
      domain: "legacy",
      summary: "legacy event",
      intent: "test",
      outcome: "success",
    }, "legacy_platform");

    // The event platform is encrypted, but sim legacy by setting plaintext
    const event = ledger.getTimeline({ last_n: 1 })[0];
    (ledger as any).db.prepare("UPDATE timeline_events SET platform = ? WHERE event_id = ?")
      .run("legacy platform plaintext", event.event_id);

    const oldState = ledger.getDomainContext(["legacy"]);
    expect(oldState.legacy).toEqual({}); // parsed {}

    // Rotation should encrypt legacy plaintext
    const result = ledger.rotateKey();
    expect(result.reencrypted).toBeGreaterThan(0);

    // New state should have the legacy data encrypted but accessible
    const newState = ledger.getDomainContext(["legacy"]);
    expect(newState.legacy).toEqual({}); // still {}, but was encrypted

    // Verify raw is now encrypted. Rotation re-pseudonymizes every domain
    // under the new master key, so we must look the row up by the new pseudo.
    const newPseudo = (ledger as any).domainPseudonym("legacy");
    const rawCtx = ((ledger as any).db).prepare("SELECT context FROM domain_context WHERE domain = ?").get(newPseudo) as any;
    expect(rawCtx.context.startsWith("enc:")).toBe(true);
    expect(rawCtx.context).not.toBe("legacy plaintext context");

    // Check the event platform
    const newTimeline = ledger.getTimeline({ last_n: 1 });
    expect(newTimeline[0].platform).toBe("legacy platform plaintext");
  });
});
