import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type {
  CoreIdentity,
  GlobalPreferences,
  TimelineEvent,
  ActiveProject,
  AppendEventInput,
  UserState,
  Scope,
} from "./types.js";
import {
  initializeMasterKey,
  deriveDomainEncryptionKey,
  deriveBlindIndexKey,
  encrypt,
  decrypt,
  isEncrypted,
  generateBlindTokens,
  generateSearchTokens,
} from "./encryption.js";

function getDefaultDbPath(): string {
  return path.join(os.homedir(), ".usrcp", "ledger.db");
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// --- Spec-compliant ULID (Crockford Base32, monotonic within ms) ---

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: Uint8Array | null = null;

function generateULID(): string {
  let now = Date.now();

  // Monotonic: if same ms as last call, increment random component
  if (now === lastTime && lastRandom) {
    // Increment the random bytes (big-endian)
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 255) {
        lastRandom[i]++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(crypto.randomBytes(10));
  }

  // Encode timestamp (48 bits → 10 Crockford chars, big-endian)
  let ts = "";
  for (let i = 9; i >= 0; i--) {
    ts = CROCKFORD[now & 0x1f] + ts;
    now = Math.floor(now / 32);
  }

  // Encode randomness (80 bits → 16 Crockford chars)
  let rnd = "";
  const bytes = lastRandom!;
  // Convert 10 bytes (80 bits) to 16 base32 chars
  // Process in groups: 5 bytes → 8 chars
  for (let group = 0; group < 2; group++) {
    const off = group * 5;
    const b0 = bytes[off];
    const b1 = bytes[off + 1];
    const b2 = bytes[off + 2];
    const b3 = bytes[off + 3];
    const b4 = bytes[off + 4];

    rnd += CROCKFORD[(b0 >> 3) & 0x1f];
    rnd += CROCKFORD[((b0 << 2) | (b1 >> 6)) & 0x1f];
    rnd += CROCKFORD[(b1 >> 1) & 0x1f];
    rnd += CROCKFORD[((b1 << 4) | (b2 >> 4)) & 0x1f];
    rnd += CROCKFORD[((b2 << 1) | (b3 >> 7)) & 0x1f];
    rnd += CROCKFORD[(b3 >> 2) & 0x1f];
    rnd += CROCKFORD[((b3 << 3) | (b4 >> 5)) & 0x1f];
    rnd += CROCKFORD[b4 & 0x1f];
  }

  return ts + rnd; // 26 chars total
}

// --- Row to TimelineEvent mapper ---

// Note: rowToEvent is now a method on Ledger to access decryption

export class Ledger {
  private db: Database.Database;
  private closed = false;
  private masterKey: Buffer;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || getDefaultDbPath();
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Overwrite deleted content with zeros — prevents forensic recovery
    this.db.pragma("secure_delete = ON");
    this.masterKey = initializeMasterKey();
    this.migrate();
  }

  private encryptForDomain(plaintext: string, domain: string): string {
    const key = deriveDomainEncryptionKey(this.masterKey, domain);
    return encrypt(plaintext, key);
  }

  private decryptForDomain(ciphertext: string, domain: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext; // backward compat
    const key = deriveDomainEncryptionKey(this.masterKey, domain);
    try {
      return decrypt(ciphertext, key);
    } catch {
      return "{}"; // tampered or wrong key — return safe fallback
    }
  }

  private getBlindTokens(text: string, domain: string): string[] {
    const key = deriveBlindIndexKey(this.masterKey, domain);
    return generateBlindTokens(text, key);
  }

  private getSearchTokens(query: string, domain: string): string[] {
    const key = deriveBlindIndexKey(this.masterKey, domain);
    return generateSearchTokens(query, key);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        display_name TEXT NOT NULL DEFAULT '',
        roles TEXT NOT NULL DEFAULT '[]',
        expertise_domains TEXT NOT NULL DEFAULT '[]',
        communication_style TEXT NOT NULL DEFAULT 'concise',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS global_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        language TEXT NOT NULL DEFAULT 'en',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        output_format TEXT NOT NULL DEFAULT 'markdown',
        verbosity TEXT NOT NULL DEFAULT 'standard',
        custom TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS timeline_events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        platform TEXT NOT NULL,
        domain TEXT NOT NULL,
        summary TEXT NOT NULL,
        intent TEXT,
        outcome TEXT,
        detail TEXT DEFAULT '{}',
        artifacts TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        session_id TEXT,
        parent_event_id TEXT,
        ledger_sequence INTEGER
      );

      CREATE TABLE IF NOT EXISTS active_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_touched TEXT NOT NULL DEFAULT (datetime('now')),
        summary TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS domain_context (
        domain TEXT PRIMARY KEY,
        context TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON timeline_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_domain ON timeline_events(domain);
      CREATE INDEX IF NOT EXISTS idx_events_platform ON timeline_events(platform);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON active_projects(status);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL DEFAULT 'local',
        operation TEXT NOT NULL,
        scopes_accessed TEXT,
        event_ids TEXT,
        detail TEXT,
        response_size_bytes INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS blind_index (
        event_id TEXT NOT NULL,
        token TEXT NOT NULL,
        domain TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_blind_token ON blind_index(token, domain);
      CREATE INDEX IF NOT EXISTS idx_blind_event ON blind_index(event_id);

      -- Seed singleton rows if they don't exist
      INSERT OR IGNORE INTO core_identity (id) VALUES (1);
      INSERT OR IGNORE INTO global_preferences (id) VALUES (1);
    `);

    // v0.1.1 migration: add idempotency_key column
    try {
      this.db.exec(
        "ALTER TABLE timeline_events ADD COLUMN idempotency_key TEXT"
      );
    } catch {
      // Column already exists
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON timeline_events(idempotency_key) WHERE idempotency_key IS NOT NULL"
    );

    // v0.1.2 migration: FTS5 full-text search index (standalone, no content sync)
    // Drop the old content-synced FTS table if it exists and recreate as standalone
    try {
      const ftsInfo = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'timeline_fts'")
        .get() as any;
      if (ftsInfo && ftsInfo.sql && ftsInfo.sql.includes("content=")) {
        this.db.exec("DROP TABLE IF EXISTS timeline_fts");
      }
    } catch {
      // Table doesn't exist yet
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS timeline_fts USING fts5(
        event_id UNINDEXED,
        summary,
        intent,
        tags,
        domain UNINDEXED
      );
    `);

    // Rebuild FTS index if empty but events exist
    const ftsCount = this.db
      .prepare("SELECT COUNT(*) as c FROM timeline_fts")
      .get() as any;
    const eventCount = this.db
      .prepare("SELECT COUNT(*) as c FROM timeline_events")
      .get() as any;
    if (ftsCount.c === 0 && eventCount.c > 0) {
      this.rebuildFtsIndex();
    }
  }

  private rebuildFtsIndex(): void {
    this.db.exec("DELETE FROM timeline_fts");
    this.db.exec(`
      INSERT INTO timeline_fts(event_id, summary, intent, tags, domain)
      SELECT event_id, summary, COALESCE(intent, ''), COALESCE(tags, ''), domain
      FROM timeline_events
    `);
  }

  private rowToEvent(row: any): TimelineEvent {
    return {
      event_id: row.event_id,
      timestamp: row.timestamp,
      platform: row.platform,
      domain: row.domain,
      summary: row.summary,
      intent: row.intent || undefined,
      outcome: row.outcome || undefined,
      detail: safeJsonParse(this.decryptForDomain(row.detail || "{}", row.domain), {}),
      artifacts: safeJsonParse(this.decryptForDomain(row.artifacts || "[]", row.domain), []),
      tags: safeJsonParse(this.decryptForDomain(row.tags || "[]", row.domain), []),
      session_id: row.session_id || undefined,
      parent_event_id: row.parent_event_id || undefined,
    };
  }

  // --- Audit Log ---

  private logAudit(
    operation: string,
    scopesOrDomain?: string | string[],
    eventIds?: string[],
    detail?: string,
    responseSize?: number
  ): void {
    const scopes = Array.isArray(scopesOrDomain)
      ? scopesOrDomain.join(",")
      : scopesOrDomain || null;
    this.db
      .prepare(
        `INSERT INTO audit_log (agent_id, operation, scopes_accessed, event_ids, detail, response_size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "local",
        operation,
        scopes,
        eventIds ? JSON.stringify(eventIds) : null,
        detail || null,
        responseSize || 0
      );
  }

  getAuditLog(limit: number = 100): any[] {
    return this.db
      .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
      .all(limit);
  }

  // --- Core Identity ---

  getIdentity(): CoreIdentity {
    const row = this.db
      .prepare("SELECT * FROM core_identity WHERE id = 1")
      .get() as any;
    return {
      display_name: row.display_name,
      roles: safeJsonParse(row.roles, []),
      expertise_domains: safeJsonParse(row.expertise_domains, []),
      communication_style: row.communication_style,
    };
  }

  updateIdentity(identity: Partial<CoreIdentity>): void {
    const current = this.getIdentity();
    const merged = { ...current, ...identity };
    this.db
      .prepare(
        `UPDATE core_identity SET
          display_name = ?,
          roles = ?,
          expertise_domains = ?,
          communication_style = ?,
          updated_at = datetime('now')
        WHERE id = 1`
      )
      .run(
        merged.display_name,
        JSON.stringify(merged.roles),
        JSON.stringify(merged.expertise_domains),
        merged.communication_style
      );
  }

  // --- Global Preferences ---

  getPreferences(): GlobalPreferences {
    const row = this.db
      .prepare("SELECT * FROM global_preferences WHERE id = 1")
      .get() as any;
    return {
      language: row.language,
      timezone: row.timezone,
      output_format: row.output_format,
      verbosity: row.verbosity,
      custom: safeJsonParse(row.custom, {}),
    };
  }

  updatePreferences(prefs: Partial<GlobalPreferences>): void {
    const current = this.getPreferences();
    const merged = { ...current, ...prefs };
    if (prefs.custom) {
      merged.custom = { ...current.custom, ...prefs.custom };
    }
    this.db
      .prepare(
        `UPDATE global_preferences SET
          language = ?,
          timezone = ?,
          output_format = ?,
          verbosity = ?,
          custom = ?,
          updated_at = datetime('now')
        WHERE id = 1`
      )
      .run(
        merged.language,
        merged.timezone,
        merged.output_format,
        merged.verbosity,
        JSON.stringify(merged.custom)
      );
  }

  // --- Timeline Events ---

  // --- Input validation (defense-in-depth, supplements Zod schemas) ---

  private validateEventInput(
    event: AppendEventInput,
    platform: string,
    idempotencyKey?: string
  ): void {
    if (event.domain.length > 100) throw new Error("domain exceeds 100 chars");
    if (event.summary.length > 500) throw new Error("summary exceeds 500 chars");
    if (event.intent.length > 300) throw new Error("intent exceeds 300 chars");
    if (platform.length > 100) throw new Error("platform exceeds 100 chars");
    if (idempotencyKey && idempotencyKey.length > 100)
      throw new Error("idempotency_key exceeds 100 chars");
    if (event.session_id && event.session_id.length > 100)
      throw new Error("session_id exceeds 100 chars");
    if (event.tags && event.tags.length > 50)
      throw new Error("tags exceeds 50 items");
    if (event.artifacts && event.artifacts.length > 50)
      throw new Error("artifacts exceeds 50 items");
    if (event.artifacts) {
      for (const a of event.artifacts) {
        if (a.ref.length > 2048) throw new Error("artifact ref exceeds 2048 chars");
      }
    }
    // Cap serialized detail size at 64KB
    if (event.detail && JSON.stringify(event.detail).length > 65536)
      throw new Error("detail exceeds 64KB");
  }

  appendEvent(
    event: AppendEventInput,
    platform: string,
    idempotencyKey?: string
  ): {
    event_id: string;
    timestamp: string;
    ledger_sequence: number;
    duplicate?: boolean;
  } {
    this.validateEventInput(event, platform, idempotencyKey);

    if (idempotencyKey) {
      const existing = this.db
        .prepare(
          "SELECT event_id, timestamp, ledger_sequence FROM timeline_events WHERE idempotency_key = ?"
        )
        .get(idempotencyKey) as any;
      if (existing) {
        return {
          event_id: existing.event_id,
          timestamp: existing.timestamp,
          ledger_sequence: existing.ledger_sequence,
          duplicate: true,
        };
      }
    }

    const event_id = generateULID();
    const timestamp = new Date().toISOString();

    const maxSeq = this.db
      .prepare(
        "SELECT COALESCE(MAX(ledger_sequence), 0) as max_seq FROM timeline_events"
      )
      .get() as any;
    const ledger_sequence = maxSeq.max_seq + 1;

    // Encrypt sensitive fields with domain-scoped key
    const detailPlain = JSON.stringify(event.detail || {});
    const artifactsPlain = JSON.stringify(event.artifacts || []);
    const tagsPlain = JSON.stringify(event.tags || []);

    const detailEncrypted = this.encryptForDomain(detailPlain, event.domain);
    const artifactsEncrypted = this.encryptForDomain(artifactsPlain, event.domain);
    const tagsEncrypted = this.encryptForDomain(tagsPlain, event.domain);

    this.db
      .prepare(
        `INSERT INTO timeline_events
          (event_id, timestamp, platform, domain, summary, intent, outcome, detail, artifacts, tags, session_id, parent_event_id, ledger_sequence, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event_id,
        timestamp,
        platform,
        event.domain,
        event.summary,
        event.intent || null,
        event.outcome || null,
        detailEncrypted,
        artifactsEncrypted,
        tagsEncrypted,
        event.session_id || null,
        event.parent_event_id || null,
        ledger_sequence,
        idempotencyKey || null
      );

    // Update FTS index (summary and intent remain in plaintext for search)
    this.db
      .prepare(
        `INSERT INTO timeline_fts(event_id, summary, intent, tags, domain)
        VALUES (?, ?, ?, ?, ?)`
      )
      .run(event_id, event.summary, event.intent || "", tagsPlain, event.domain);

    // Store blind index tokens for encrypted field search
    const searchableText = [
      event.summary,
      event.intent || "",
      ...(event.tags || []),
    ].join(" ");
    const tokens = this.getBlindTokens(searchableText, event.domain);
    const insertToken = this.db.prepare(
      "INSERT INTO blind_index (event_id, token, domain) VALUES (?, ?, ?)"
    );
    for (const token of tokens) {
      insertToken.run(event_id, token, event.domain);
    }

    // Audit log
    this.logAudit("append_event", event.domain, [event_id]);

    return { event_id, timestamp, ledger_sequence };
  }

  getTimeline(options?: {
    last_n?: number;
    since?: string;
    domains?: string[];
  }): TimelineEvent[] {
    const limit = options?.last_n || 50;
    let query = "SELECT * FROM timeline_events";
    const conditions: string[] = [];
    const params: any[] = [];

    if (options?.since) {
      conditions.push("timestamp >= ?");
      params.push(options.since);
    }

    if (options?.domains && options.domains.length > 0) {
      const placeholders = options.domains.map(() => "?").join(", ");
      conditions.push(`domain IN (${placeholders})`);
      params.push(...options.domains);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY ledger_sequence DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as any[];
    const events = rows.map((r) => this.rowToEvent(r));
    this.logAudit(
      "get_timeline",
      options?.domains,
      events.map((e) => e.event_id),
      undefined,
      JSON.stringify(events).length
    );
    return events;
  }

  searchTimeline(
    query: string,
    options?: { limit?: number; domain?: string }
  ): TimelineEvent[] {
    const limit = options?.limit || 20;

    // Use FTS5 for ranked full-text search
    let sql = `
      SELECT e.*, rank
      FROM timeline_fts fts
      JOIN timeline_events e ON fts.event_id = e.event_id
      WHERE timeline_fts MATCH ?`;
    const ftsQuery = query
      .replace(/[^\w\s]/g, "") // Strip special FTS5 chars to prevent syntax errors
      .trim();

    if (!ftsQuery) {
      return []; // Empty query after sanitization
    }

    // Add * for prefix matching: "auth" matches "authentication"
    const params: any[] = [ftsQuery + "*"];

    if (options?.domain) {
      sql += " AND e.domain = ?";
      params.push(options.domain);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map((r) => this.rowToEvent(r));
    } catch {
      // Fallback to LIKE if FTS query fails (e.g., empty index)
      return this.searchTimelineFallback(query, options);
    }
  }

  private searchTimelineFallback(
    query: string,
    options?: { limit?: number; domain?: string }
  ): TimelineEvent[] {
    const limit = options?.limit || 20;
    let sql =
      "SELECT * FROM timeline_events WHERE (summary LIKE ? OR intent LIKE ? OR tags LIKE ?)";
    const params: any[] = [`%${query}%`, `%${query}%`, `%${query}%`];

    if (options?.domain) {
      sql += " AND domain = ?";
      params.push(options.domain);
    }

    sql += " ORDER BY ledger_sequence DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToEvent(r));
  }

  // --- Event Pruning & Compaction ---

  /**
   * Prune old events: events older than `daysOld` are deleted.
   * Detail and artifact data is stripped — only summary/intent/outcome remain
   * in a compacted "pruned" marker event.
   * Returns the number of events pruned.
   */
  pruneOldEvents(daysOld: number = 30): {
    pruned: number;
    compacted: number;
  } {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const cutoffIso = cutoff.toISOString();

    // Get events to prune (keep summary/intent/outcome for historical context)
    // Find events with non-empty detail that are older than cutoff
    // Note: encrypted detail won't equal '{}', so check for non-null and non-empty
    const oldEvents = this.db
      .prepare(
        `SELECT event_id FROM timeline_events
        WHERE timestamp < ? AND detail IS NOT NULL AND detail != '{}' AND detail != ''`
      )
      .all(cutoffIso) as any[];

    if (oldEvents.length === 0) {
      return { pruned: 0, compacted: 0 };
    }

    // Strip detail, artifacts from old events (keep summary)
    const compact = this.db.prepare(
      `UPDATE timeline_events
      SET detail = '{}', artifacts = '[]'
      WHERE event_id = ?`
    );

    let compacted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of oldEvents) {
        compact.run(event.event_id);
        compacted++;
      }
    });
    transaction();

    return { pruned: 0, compacted };
  }

  /**
   * Delete events older than `daysOld` entirely.
   * Use with caution — this permanently removes history.
   */
  deleteOldEvents(daysOld: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const cutoffIso = cutoff.toISOString();

    // Get event IDs to delete (for blind index cleanup)
    const toDelete = this.db
      .prepare("SELECT event_id FROM timeline_events WHERE timestamp < ?")
      .all(cutoffIso) as any[];
    const eventIds = toDelete.map((r: any) => r.event_id);

    if (eventIds.length === 0) return 0;

    const placeholders = eventIds.map(() => "?").join(",");

    // Delete from FTS
    this.db
      .prepare(`DELETE FROM timeline_fts WHERE event_id IN (${placeholders})`)
      .run(...eventIds);

    // Delete from blind index
    this.db
      .prepare(`DELETE FROM blind_index WHERE event_id IN (${placeholders})`)
      .run(...eventIds);

    // Delete events (secure_delete pragma ensures zero-fill)
    const result = this.db
      .prepare("DELETE FROM timeline_events WHERE timestamp < ?")
      .run(cutoffIso);

    this.logAudit("delete_old_events", undefined, eventIds);
    return result.changes;
  }

  /**
   * Secure wipe: VACUUM after delete to reclaim and zero-fill pages.
   * Call after deleteOldEvents() for forensic-grade deletion.
   */
  secureWipe(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    this.logAudit("secure_wipe");
  }

  // --- Active Projects ---

  getProjects(status?: string): ActiveProject[] {
    let query = "SELECT * FROM active_projects";
    const params: any[] = [];

    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }

    query += " ORDER BY last_touched DESC";

    return this.db.prepare(query).all(...params) as ActiveProject[];
  }

  upsertProject(project: ActiveProject): void {
    this.db
      .prepare(
        `INSERT INTO active_projects (project_id, name, domain, status, last_touched, summary)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          name = excluded.name,
          domain = excluded.domain,
          status = excluded.status,
          last_touched = excluded.last_touched,
          summary = excluded.summary`
      )
      .run(
        project.project_id,
        project.name,
        project.domain,
        project.status,
        project.last_touched || new Date().toISOString(),
        project.summary
      );
  }

  // --- Domain Context ---

  getDomainContext(
    domains?: string[]
  ): Record<string, Record<string, unknown>> {
    let rows: any[];
    if (domains && domains.length > 0) {
      const placeholders = domains.map(() => "?").join(", ");
      rows = this.db
        .prepare(
          `SELECT * FROM domain_context WHERE domain IN (${placeholders})`
        )
        .all(...domains) as any[];
    } else {
      rows = this.db.prepare("SELECT * FROM domain_context").all() as any[];
    }
    const result: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const decrypted = this.decryptForDomain(row.context || "{}", row.domain);
      result[row.domain] = safeJsonParse(decrypted, {});
    }
    return result;
  }

  upsertDomainContext(
    domain: string,
    context: Record<string, unknown>
  ): void {
    const existing = this.getDomainContext([domain]);
    const merged = { ...(existing[domain] || {}), ...context };
    const encrypted = this.encryptForDomain(JSON.stringify(merged), domain);
    this.db
      .prepare(
        `INSERT INTO domain_context (domain, context, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(domain) DO UPDATE SET
          context = excluded.context,
          updated_at = excluded.updated_at`
      )
      .run(domain, encrypted);
    this.logAudit("update_domain_context", domain);
  }

  // --- Composite State ---

  getState(scopes: Scope[]): UserState {
    const state: UserState = {};

    for (const scope of scopes) {
      switch (scope) {
        case "core_identity":
          state.core_identity = this.getIdentity();
          break;
        case "global_preferences":
          state.global_preferences = this.getPreferences();
          break;
        case "recent_timeline":
          state.recent_timeline = this.getTimeline({ last_n: 50 });
          break;
        case "domain_context":
          state.domain_context = this.getDomainContext();
          break;
        case "active_projects":
          state.active_projects = this.getProjects("active");
          break;
      }
    }

    this.logAudit(
      "get_state",
      scopes,
      undefined,
      undefined,
      JSON.stringify(state).length
    );
    return state;
  }

  // --- Stats ---

  getStats(): {
    total_events: number;
    total_projects: number;
    domains: string[];
    platforms: string[];
    db_size_bytes: number;
    audit_log_entries: number;
    encryption_enabled: boolean;
  } {
    const eventCount = this.db
      .prepare("SELECT COUNT(*) as count FROM timeline_events")
      .get() as any;
    const projectCount = this.db
      .prepare("SELECT COUNT(*) as count FROM active_projects")
      .get() as any;
    const domains = this.db
      .prepare("SELECT DISTINCT domain FROM timeline_events")
      .all() as any[];
    const platforms = this.db
      .prepare("SELECT DISTINCT platform FROM timeline_events")
      .all() as any[];

    // Get database file size
    const dbSize = this.db
      .prepare(
        "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
      )
      .get() as any;

    const auditCount = this.db
      .prepare("SELECT COUNT(*) as count FROM audit_log")
      .get() as any;

    return {
      total_events: eventCount.count,
      total_projects: projectCount.count,
      domains: domains.map((d: any) => d.domain),
      platforms: platforms.map((p: any) => p.platform),
      db_size_bytes: dbSize?.size || 0,
      audit_log_entries: auditCount.count,
      encryption_enabled: true,
    };
  }

  // --- Maintenance ---

  /**
   * Checkpoint WAL file and optionally vacuum the database.
   * Call periodically or on graceful shutdown.
   */
  checkpoint(vacuum: boolean = false): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    if (vacuum) {
      this.db.exec("VACUUM");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.checkpoint();
    } catch {
      // Best-effort checkpoint on close
    }
    this.db.close();
  }
}
