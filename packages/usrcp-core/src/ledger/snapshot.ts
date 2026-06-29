/**
 * Snapshot + restore for the ledger DB.
 *
 * Solves the "one corrupt write and you lose everything" failure mode: take
 * periodic atomic copies of the SQLite DB, keep a retention window, and
 * provide a `restore` path that swaps the active DB for a known-good copy.
 *
 * Atomicity: snapshots use SQLite's `VACUUM INTO`, which produces a single
 * defragmented copy without WAL/SHM sidecars. Safe to run while the ledger
 * is in use — VACUUM INTO does not lock writers.
 *
 * Layout:
 *   ~/.usrcp/users/<slug>/ledger.db
 *   ~/.usrcp/users/<slug>/snapshots/<iso>.db
 *   ~/.usrcp/users/<slug>/.pre-restore-<iso>.db   (post-restore safety copy)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import Database from "better-sqlite3";

export interface SnapshotMeta {
  /** Absolute path to the snapshot file. */
  path: string;
  /** ISO timestamp parsed from the filename. */
  takenAt: Date;
  /** Bytes on disk. */
  sizeBytes: number;
}

export interface RetentionPolicy {
  /** Keep this many of the most-recent snapshots regardless of age. */
  recent: number;
  /** Keep one snapshot per day for the last N days. */
  daily: number;
  /** Keep one snapshot per ISO-week for the last N weeks. */
  weekly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { recent: 3, daily: 7, weekly: 4 };

const SNAPSHOT_FILENAME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db$/;

/**
 * Format a Date as a filesystem-safe ISO string at second precision.
 * Colons are replaced with hyphens and milliseconds are dropped — that's
 * enough resolution for snapshots and avoids the punctuation ambiguity
 * that comes with mixing `:`, `.`, and filename-safe characters.
 */
export function formatSnapshotName(d: Date): string {
  // Round to whole seconds so the round-trip through ISO is lossless.
  const truncated = new Date(Math.floor(d.getTime() / 1000) * 1000);
  return `${truncated.toISOString().replace(/[:.]\d{3}Z$/, "Z").replace(/:/g, "-")}.db`;
}

export function parseSnapshotFilename(name: string): Date | null {
  const m = SNAPSHOT_FILENAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Take an atomic snapshot of `dbPath` into `snapshotsDir`.
 * Creates the directory if it doesn't exist. Returns metadata for the
 * snapshot just written.
 */
export function takeSnapshot(
  dbPath: string,
  snapshotsDir: string,
  now: Date = new Date(),
): SnapshotMeta {
  fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const name = formatSnapshotName(now);
  const dest = path.join(snapshotsDir, name);

  // Open read-only on the source. VACUUM INTO is the only mutation, against
  // a destination path that doesn't exist yet — so this is safe to run while
  // the ledger has live writers (better-sqlite3 + WAL allows it).
  const db = new Database(dbPath, { readonly: true });
  try {
    // VACUUM INTO requires a literal string, but better-sqlite3's prepare
    // doesn't allow parameterizing it. Path is server-controlled (we built
    // it from snapshotsDir + ISO date), so direct interpolation is fine —
    // but we still defensively reject anything with quotes.
    if (dest.includes("'") || dest.includes('"')) {
      throw new Error(`unsafe snapshot path: ${dest}`);
    }
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const stat = fs.statSync(dest);
  return { path: dest, takenAt: now, sizeBytes: stat.size };
}

/**
 * List snapshots in directory order (newest first). Files that don't match
 * the snapshot naming convention are ignored.
 */
export function listSnapshots(snapshotsDir: string): SnapshotMeta[] {
  if (!fs.existsSync(snapshotsDir)) return [];
  const entries = fs.readdirSync(snapshotsDir, { withFileTypes: true });
  const metas: SnapshotMeta[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const takenAt = parseSnapshotFilename(e.name);
    if (!takenAt) continue;
    const full = path.join(snapshotsDir, e.name);
    const stat = fs.statSync(full);
    metas.push({ path: full, takenAt, sizeBytes: stat.size });
  }
  return metas.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
}

/**
 * Decide which snapshots to keep under the retention policy. Pure function
 * — takes metadata + a "now" reference, returns the subset to keep.
 *
 * Rules (union of three buckets):
 *   - The N most-recent snapshots, regardless of age.
 *   - One snapshot per UTC calendar day for the last `daily` days
 *     (the newest snapshot taken that day wins).
 *   - One snapshot per ISO-week for the last `weekly` weeks.
 */
export function pickRetentionWinners(
  snapshots: readonly SnapshotMeta[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: Date = new Date(),
): Set<string> {
  const sorted = [...snapshots].sort(
    (a, b) => b.takenAt.getTime() - a.takenAt.getTime(),
  );

  const keep = new Set<string>();
  for (let i = 0; i < Math.min(policy.recent, sorted.length); i++) {
    keep.add(sorted[i].path);
  }

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const weekKey = (d: Date) => isoWeekKey(d);

  const cutoffDaily = new Date(now.getTime() - policy.daily * 86_400_000);
  const cutoffWeekly = new Date(now.getTime() - policy.weekly * 7 * 86_400_000);

  const seenDays = new Set<string>();
  const seenWeeks = new Set<string>();

  for (const s of sorted) {
    if (s.takenAt >= cutoffDaily) {
      const k = dayKey(s.takenAt);
      if (!seenDays.has(k)) {
        seenDays.add(k);
        keep.add(s.path);
      }
    }
    if (s.takenAt >= cutoffWeekly) {
      const k = weekKey(s.takenAt);
      if (!seenWeeks.has(k)) {
        seenWeeks.add(k);
        keep.add(s.path);
      }
    }
  }

  return keep;
}

function isoWeekKey(d: Date): string {
  // ISO-8601 week: Thursday determines the year.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diffDays = (target.getTime() - firstThursday.getTime()) / 86_400_000;
  const week = 1 + Math.round(diffDays / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface PruneResult {
  kept: SnapshotMeta[];
  removed: SnapshotMeta[];
}

export function pruneSnapshots(
  snapshotsDir: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: Date = new Date(),
): PruneResult {
  const all = listSnapshots(snapshotsDir);
  const winners = pickRetentionWinners(all, policy, now);
  const removed: SnapshotMeta[] = [];
  const kept: SnapshotMeta[] = [];
  for (const s of all) {
    if (winners.has(s.path)) {
      kept.push(s);
    } else {
      fs.unlinkSync(s.path);
      removed.push(s);
    }
  }
  return { kept, removed };
}

export interface SnapshotSummary {
  totalEvents: number;
  totalFacts: number;
  totalProjects: number;
  domains: number;
  identityDisplayName: string | null;
  latestEventAt: string | null;
}

/**
 * Open a snapshot file read-only and produce a quick summary. Used by
 * `restore --dry-run` to show the user what's in the snapshot before they
 * commit to swapping it in.
 */
export function summarizeSnapshot(snapshotPath: string): SnapshotSummary {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const events = db.prepare("SELECT COUNT(*) as c FROM timeline_events").get() as { c: number };
    let facts = 0;
    try {
      const factRow = db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number };
      facts = factRow?.c ?? 0;
    } catch {
      // facts table may not exist on very old snapshots — treat as 0
    }
    const projects = db.prepare("SELECT COUNT(*) as c FROM active_projects").get() as { c: number };
    const domains = db
      .prepare("SELECT COUNT(DISTINCT domain) as c FROM timeline_events")
      .get() as { c: number };
    let identityName: string | null = null;
    try {
      const row = db
        .prepare("SELECT display_name FROM core_identity WHERE id = 1")
        .get() as { display_name: string | null } | undefined;
      identityName = row?.display_name ?? null;
    } catch {
      // older schema — skip
    }
    const latest = db
      .prepare("SELECT MAX(timestamp) as ts FROM timeline_events")
      .get() as { ts: string | null };
    return {
      totalEvents: events.c,
      totalFacts: facts,
      totalProjects: projects.c,
      domains: domains.c,
      identityDisplayName: identityName,
      latestEventAt: latest.ts,
    };
  } finally {
    db.close();
  }
}

/**
 * Verify a snapshot file is a usable SQLite DB before we trust it for
 * a restore. Returns null on success, an error message string on failure.
 */
export function verifySnapshot(snapshotPath: string): string | null {
  if (!fs.existsSync(snapshotPath)) return `snapshot not found: ${snapshotPath}`;
  let db: Database.Database;
  try {
    db = new Database(snapshotPath, { readonly: true });
  } catch (e) {
    return `cannot open snapshot: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    let result: Array<{ integrity_check: string }>;
    try {
      result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    } catch (e) {
      return `cannot read snapshot: ${e instanceof Error ? e.message : String(e)}`;
    }
    const lines = result.map((r) => r.integrity_check);
    if (lines.length === 1 && lines[0] === "ok") return null;
    return `integrity_check failed: ${lines.join("; ")}`;
  } finally {
    db.close();
  }
}

/**
 * Replace the active DB with a snapshot.
 *
 * Steps:
 *  1. Verify the snapshot is healthy.
 *  2. Move the current ledger.db (and any -wal/-shm sidecars) to
 *     `.pre-restore-<iso>.db`.
 *  3. Copy the snapshot to ledger.db.
 *
 * Caller must ensure no Ledger instance is currently open against
 * `dbPath`. The lazy/serve-startup path enforces this — restore is a
 * separate CLI command, not callable while serving.
 */
export function restoreSnapshot(
  snapshotPath: string,
  dbPath: string,
  now: Date = new Date(),
): { preRestorePath: string | null } {
  const err = verifySnapshot(snapshotPath);
  if (err) throw new Error(err);

  const preRestorePath = fs.existsSync(dbPath)
    ? path.join(
        path.dirname(dbPath),
        `.pre-restore-${formatSnapshotName(now)}`,
      )
    : null;

  if (preRestorePath) {
    fs.renameSync(dbPath, preRestorePath);
    // WAL/SHM sidecars: move them too if present, so the pre-restore copy
    // is complete and the new DB starts with no stale journal state.
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${dbPath}${suffix}`;
      if (fs.existsSync(side)) {
        fs.renameSync(side, `${preRestorePath}${suffix}`);
      }
    }
  }

  fs.copyFileSync(snapshotPath, dbPath);
  fs.chmodSync(dbPath, 0o600);
  return { preRestorePath };
}

/**
 * Returns true if the most recent snapshot in `snapshotsDir` is older
 * than `maxAgeMs`, OR if there are no snapshots at all. Used by the
 * lazy-snapshot path on serve startup.
 */
export function shouldTakeLazySnapshot(
  snapshotsDir: string,
  maxAgeMs: number,
  now: Date = new Date(),
): boolean {
  const all = listSnapshots(snapshotsDir);
  if (all.length === 0) return true;
  return now.getTime() - all[0].takenAt.getTime() > maxAgeMs;
}

/**
 * Run PRAGMA integrity_check against a DB file. Returns null if healthy,
 * else a human-readable error message.
 */
export function checkDbIntegrity(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null; // empty/uninitialized — handled elsewhere
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return `cannot open ${dbPath}: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    let result: Array<{ integrity_check: string }>;
    try {
      result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    const lines = result.map((r) => r.integrity_check);
    if (lines.length === 1 && lines[0] === "ok") return null;
    return lines.join("; ");
  } finally {
    db.close();
  }
}
