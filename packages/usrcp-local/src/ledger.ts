import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
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

function getDefaultDbPath(): string {
  return path.join(process.env.HOME || "~", ".usrcp", "ledger.db");
}

function generateULID(): string {
  const timestamp = Date.now().toString(36).padStart(10, "0");
  const random = crypto.randomBytes(10).toString("hex").slice(0, 16);
  return `${timestamp}${random}`.toUpperCase();
}

export class Ledger {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || getDefaultDbPath();
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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
      CREATE INDEX IF NOT EXISTS idx_events_tags ON timeline_events(tags);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON active_projects(status);

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
      // Column already exists — safe to ignore
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON timeline_events(idempotency_key) WHERE idempotency_key IS NOT NULL"
    );
  }

  // --- Core Identity ---

  getIdentity(): CoreIdentity {
    const row = this.db
      .prepare("SELECT * FROM core_identity WHERE id = 1")
      .get() as any;
    return {
      display_name: row.display_name,
      roles: JSON.parse(row.roles),
      expertise_domains: JSON.parse(row.expertise_domains),
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
      custom: JSON.parse(row.custom),
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
    // Check idempotency key for duplicate prevention
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
        JSON.stringify(event.detail || {}),
        JSON.stringify(event.artifacts || []),
        JSON.stringify(event.tags || []),
        event.session_id || null,
        event.parent_event_id || null,
        ledger_sequence,
        idempotencyKey || null
      );

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

    return rows.map((row) => ({
      event_id: row.event_id,
      timestamp: row.timestamp,
      platform: row.platform,
      domain: row.domain,
      summary: row.summary,
      intent: row.intent || undefined,
      outcome: row.outcome || undefined,
      detail: JSON.parse(row.detail || "{}"),
      artifacts: JSON.parse(row.artifacts || "[]"),
      tags: JSON.parse(row.tags || "[]"),
      session_id: row.session_id || undefined,
      parent_event_id: row.parent_event_id || undefined,
    }));
  }

  searchTimeline(
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

    return rows.map((row) => ({
      event_id: row.event_id,
      timestamp: row.timestamp,
      platform: row.platform,
      domain: row.domain,
      summary: row.summary,
      intent: row.intent || undefined,
      outcome: row.outcome || undefined,
      detail: JSON.parse(row.detail || "{}"),
      artifacts: JSON.parse(row.artifacts || "[]"),
      tags: JSON.parse(row.tags || "[]"),
      session_id: row.session_id || undefined,
      parent_event_id: row.parent_event_id || undefined,
    }));
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
      result[row.domain] = JSON.parse(row.context);
    }
    return result;
  }

  upsertDomainContext(
    domain: string,
    context: Record<string, unknown>
  ): void {
    const existing = this.getDomainContext([domain]);
    const merged = { ...(existing[domain] || {}), ...context };
    this.db
      .prepare(
        `INSERT INTO domain_context (domain, context, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(domain) DO UPDATE SET
          context = excluded.context,
          updated_at = excluded.updated_at`
      )
      .run(domain, JSON.stringify(merged));
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

    return state;
  }

  // --- Stats ---

  getStats(): {
    total_events: number;
    total_projects: number;
    domains: string[];
    platforms: string[];
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

    return {
      total_events: eventCount.count,
      total_projects: projectCount.count,
      domains: domains.map((d: any) => d.domain),
      platforms: platforms.map((p: any) => p.platform),
    };
  }

  close(): void {
    this.db.close();
  }
}
