import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";

import { Ledger } from "../ledger/index.js";
import {
  takeSnapshot,
  listSnapshots,
  pruneSnapshots,
  pickRetentionWinners,
  formatSnapshotName,
  parseSnapshotFilename,
  shouldTakeLazySnapshot,
  checkDbIntegrity,
  verifySnapshot,
  summarizeSnapshot,
  restoreSnapshot,
  DEFAULT_RETENTION,
  type SnapshotMeta,
} from "../ledger/snapshot.js";

let workdir: string;
let dbPath: string;
let snapshotsDir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-snapshot-"));
  dbPath = path.join(workdir, "ledger.db");
  snapshotsDir = path.join(workdir, "snapshots");
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function seedLedger(extraEvents = 0): Ledger {
  const ledger = new Ledger(dbPath);
  ledger.appendEvent(
    {
      domain: "coding",
      summary: "first session",
      intent: "test",
      outcome: "success",
    },
    "test",
  );
  for (let i = 0; i < extraEvents; i++) {
    ledger.appendEvent(
      {
        domain: "coding",
        summary: `event ${i}`,
        intent: "test",
        outcome: "success",
      },
      "test",
    );
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Filename round-trip
// ---------------------------------------------------------------------------

describe("snapshot filename helpers", () => {
  it("formats and parses round-trip at second precision", () => {
    const d = new Date("2026-04-30T12:34:56.789Z");
    const name = formatSnapshotName(d);
    expect(name).toBe("2026-04-30T12-34-56Z.db");
    const parsed = parseSnapshotFilename(name);
    // Millis are intentionally dropped — round-trip is to second precision.
    expect(parsed?.toISOString()).toBe("2026-04-30T12:34:56.000Z");
  });

  it("rejects non-snapshot filenames", () => {
    expect(parseSnapshotFilename("ledger.db")).toBeNull();
    expect(parseSnapshotFilename("notes.txt")).toBeNull();
    expect(parseSnapshotFilename("2026-04-30T12-34-56-789Z.db")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

describe("takeSnapshot", () => {
  it("creates a valid SQLite copy of the ledger", () => {
    const ledger = seedLedger();
    const meta = takeSnapshot(dbPath, snapshotsDir);
    ledger.close();

    expect(fs.existsSync(meta.path)).toBe(true);
    expect(meta.sizeBytes).toBeGreaterThan(0);

    // Snapshot should be openable as a real DB and contain the seeded event.
    const snap = new Database(meta.path, { readonly: true });
    const row = snap
      .prepare("SELECT COUNT(*) as c FROM timeline_events")
      .get() as { c: number };
    snap.close();
    expect(row.c).toBe(1);
  });

  it("can be called repeatedly with distinct timestamps", () => {
    const ledger = seedLedger();
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-30T10:00:00Z"));
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-30T11:00:00Z"));
    ledger.close();

    const snaps = listSnapshots(snapshotsDir);
    expect(snaps).toHaveLength(2);
    // listSnapshots returns newest first
    expect(snaps[0].takenAt.toISOString()).toBe("2026-04-30T11:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

describe("pickRetentionWinners", () => {
  function meta(iso: string): SnapshotMeta {
    return {
      path: `/tmp/${iso}.db`,
      takenAt: new Date(iso),
      sizeBytes: 100,
    };
  }

  it("keeps the N most recent regardless of age", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const oldSnaps = [
      meta("2025-01-01T00:00:00Z"),
      meta("2025-01-02T00:00:00Z"),
      meta("2025-01-03T00:00:00Z"),
    ];
    const winners = pickRetentionWinners(
      oldSnaps,
      { recent: 3, daily: 0, weekly: 0 },
      now,
    );
    expect(winners.size).toBe(3);
  });

  it("keeps one snapshot per UTC day within the daily window", () => {
    const now = new Date("2026-04-30T12:00:00Z");
    const snaps = [
      meta("2026-04-30T11:00:00Z"),
      meta("2026-04-30T08:00:00Z"),
      meta("2026-04-29T20:00:00Z"),
      meta("2026-04-29T03:00:00Z"),
      meta("2026-04-25T03:00:00Z"),
    ];
    const winners = pickRetentionWinners(
      snaps,
      { recent: 0, daily: 7, weekly: 0 },
      now,
    );
    // Newest per day: 04-30 11:00, 04-29 20:00, 04-25 03:00
    expect([...winners].sort()).toEqual([
      "/tmp/2026-04-25T03:00:00Z.db",
      "/tmp/2026-04-29T20:00:00Z.db",
      "/tmp/2026-04-30T11:00:00Z.db",
    ]);
  });

  it("prunes snapshots that fall in no retention bucket", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const snaps = [
      meta("2026-04-30T20:00:00Z"), // recent + daily
      meta("2026-04-30T10:00:00Z"), // same day, loses daily slot
      meta("2025-01-01T00:00:00Z"), // ancient, no bucket
    ];
    // recent:1 means only the single newest survives by recency; daily:7
    // adds the day's winner (same snap); weekly:0 disabled. Ancient drops.
    const winners = pickRetentionWinners(
      snaps,
      { recent: 1, daily: 7, weekly: 0 },
      now,
    );
    expect(winners.has("/tmp/2025-01-01T00:00:00Z.db")).toBe(false);
    expect(winners.has("/tmp/2026-04-30T10:00:00Z.db")).toBe(false);
    expect(winners.has("/tmp/2026-04-30T20:00:00Z.db")).toBe(true);
  });
});

describe("pruneSnapshots", () => {
  it("deletes snapshots not selected by retention", () => {
    const ledger = seedLedger();
    takeSnapshot(dbPath, snapshotsDir, new Date("2025-01-01T00:00:00Z"));
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-30T10:00:00Z"));
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-30T20:00:00Z"));
    ledger.close();

    const before = listSnapshots(snapshotsDir);
    expect(before).toHaveLength(3);

    const result = pruneSnapshots(
      snapshotsDir,
      { recent: 1, daily: 1, weekly: 0 },
      new Date("2026-05-01T00:00:00Z"),
    );

    // Only the newest 04-30 stays.
    expect(result.kept.map((s) => s.takenAt.toISOString())).toEqual([
      "2026-04-30T20:00:00.000Z",
    ]);
    expect(result.removed).toHaveLength(2);
    expect(listSnapshots(snapshotsDir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Lazy snapshot trigger
// ---------------------------------------------------------------------------

describe("shouldTakeLazySnapshot", () => {
  it("returns true when no snapshots exist", () => {
    expect(shouldTakeLazySnapshot(snapshotsDir, 24 * 3_600_000)).toBe(true);
  });

  it("returns false when the latest snapshot is fresh", () => {
    const ledger = seedLedger();
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-30T11:00:00Z"));
    ledger.close();
    const stillFresh = shouldTakeLazySnapshot(
      snapshotsDir,
      24 * 3_600_000,
      new Date("2026-04-30T20:00:00Z"),
    );
    expect(stillFresh).toBe(false);
  });

  it("returns true when the latest snapshot is older than maxAge", () => {
    const ledger = seedLedger();
    takeSnapshot(dbPath, snapshotsDir, new Date("2026-04-29T10:00:00Z"));
    ledger.close();
    const stale = shouldTakeLazySnapshot(
      snapshotsDir,
      24 * 3_600_000,
      new Date("2026-04-30T20:00:00Z"),
    );
    expect(stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integrity check
// ---------------------------------------------------------------------------

describe("checkDbIntegrity", () => {
  it("returns null on a healthy DB", () => {
    const ledger = seedLedger();
    ledger.close();
    expect(checkDbIntegrity(dbPath)).toBeNull();
  });

  it("returns null for a non-existent path (handled elsewhere)", () => {
    expect(checkDbIntegrity(path.join(workdir, "missing.db"))).toBeNull();
  });

  it("returns an error message for a corrupted file", () => {
    const ledger = seedLedger();
    ledger.close();
    // Corrupt the file by overwriting the SQLite header with junk.
    const handle = fs.openSync(dbPath, "r+");
    fs.writeSync(handle, Buffer.from("garbagegarbage!!"), 0, 16, 0);
    fs.closeSync(handle);
    const err = checkDbIntegrity(dbPath);
    expect(err).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verify + summarize
// ---------------------------------------------------------------------------

describe("verifySnapshot + summarizeSnapshot", () => {
  it("verifies a healthy snapshot and produces a usable summary", () => {
    const ledger = seedLedger(2);
    const meta = takeSnapshot(dbPath, snapshotsDir);
    ledger.close();

    expect(verifySnapshot(meta.path)).toBeNull();
    const summary = summarizeSnapshot(meta.path);
    expect(summary.totalEvents).toBe(3);
    expect(summary.domains).toBeGreaterThanOrEqual(1);
  });

  it("reports an error when the snapshot file is missing", () => {
    expect(verifySnapshot(path.join(snapshotsDir, "nope.db"))).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe("restoreSnapshot", () => {
  it("replaces the active DB with the snapshot and saves a pre-restore copy", () => {
    // Seed v1 (1 event), snapshot, then add more events into v2 (5 events).
    const ledger = seedLedger();
    const meta = takeSnapshot(dbPath, snapshotsDir);
    for (let i = 0; i < 4; i++) {
      ledger.appendEvent(
        {
          domain: "coding",
          summary: `extra ${i}`,
          intent: "test",
          outcome: "success",
        },
        "test",
      );
    }
    ledger.close();

    // Sanity: the live DB now has 5 events.
    {
      const live = new Database(dbPath, { readonly: true });
      const row = live
        .prepare("SELECT COUNT(*) as c FROM timeline_events")
        .get() as { c: number };
      live.close();
      expect(row.c).toBe(5);
    }

    const result = restoreSnapshot(meta.path, dbPath);

    // Pre-restore safety copy exists and still contains the v2 state.
    expect(result.preRestorePath).not.toBeNull();
    expect(fs.existsSync(result.preRestorePath!)).toBe(true);

    // Live DB now reflects v1 state (1 event).
    const restored = new Database(dbPath, { readonly: true });
    const row = restored
      .prepare("SELECT COUNT(*) as c FROM timeline_events")
      .get() as { c: number };
    restored.close();
    expect(row.c).toBe(1);
  });

  it("refuses to restore from a corrupted snapshot", () => {
    const ledger = seedLedger();
    const meta = takeSnapshot(dbPath, snapshotsDir);
    ledger.close();

    // Corrupt the snapshot.
    const handle = fs.openSync(meta.path, "r+");
    fs.writeSync(handle, Buffer.from("corruptedheader!"), 0, 16, 0);
    fs.closeSync(handle);

    expect(() => restoreSnapshot(meta.path, dbPath)).toThrow(
      /integrity_check|cannot open|not a database/,
    );
  });
});
