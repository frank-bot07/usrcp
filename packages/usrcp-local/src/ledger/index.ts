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
  TamperTracker,
  SchemaFact,
} from "../types.js";
import { VersionConflictError } from "../types.js";
import {
  initializeMasterKey,
  deriveDomainEncryptionKey,
  deriveGlobalEncryptionKey,
  deriveBlindIndexKey,
  encrypt,
  decrypt,
  isEncrypted,
  generateBlindTokens,
  generateSearchTokens,
  prepareKeyRotation,
  commitKeyRotation,
  zeroBuffer,
  safeWriteFile,
  getUserDir,
} from "../encryption.js";
import { ensurePrivateKeyEncrypted, getIdentity as getIdent, initializeIdentity as initIdent } from "../crypto.js";
import { getDefaultDbPath, safeJsonParse, generateULID } from "./helpers.js";

// --- Row to TimelineEvent mapper ---

// Note: rowToEvent is now a method on Ledger to access decryption

export class Ledger {
  private db: Database.Database;
  private closed = false;
  private masterKey: Buffer;

  constructor(dbPath?: string, passphrase?: string) {
    const resolvedPath = dbPath || getDefaultDbPath();
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.masterKey = initializeMasterKey(passphrase);
    // Initialize identity if needed (requires master key for private key encryption)
    if (!getIdent()) {
      initIdent(this.masterKey);
    }
    // Encrypt legacy plaintext private keys
    ensurePrivateKeyEncrypted(this.masterKey);
    this.migrate();

    // Key rotation recovery — if a rotation was interrupted, recover the new key
    const rotationRow = this.db.prepare("SELECT pending_key, pending_version FROM rotation_state WHERE id = 1").get() as any;
    if (rotationRow && rotationRow.pending_key) {
      const oldKey = this.masterKey;
      this.masterKey = Buffer.from(rotationRow.pending_key);
      // Zero the old key buffer — prevent heap residue
      zeroBuffer(oldKey);
      const keysDir = path.join(getUserDir(), "keys");
      fs.mkdirSync(keysDir, { recursive: true });
      safeWriteFile(path.join(keysDir, "master.key"), this.masterKey, 0o600);
      this.db.prepare("UPDATE rotation_state SET pending_key = NULL, pending_version = NULL WHERE id = 1").run();
      this.logAudit("key_rotation_recovery", ["system"]);
      this.rebuildBlindIndex();
    }
  }

  private encryptForDomain(plaintext: string, domain: string): string {
    const key = deriveDomainEncryptionKey(this.masterKey, domain);
    return encrypt(plaintext, key);
  }

  private decryptForDomain(ciphertext: string, domain: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext;
    const key = deriveDomainEncryptionKey(this.masterKey, domain);
    return decrypt(ciphertext, key);
    // GCM auth failure THROWS — this is intentional.
    // Tampered data must not be silently accepted.
  }

  /**
   * Safe decrypt that returns a fallback on failure.
   * Use ONLY for backward-compatible reads of legacy unencrypted data.
   * NEVER use for data that should be encrypted — use decryptForDomain instead.
   */
  private decryptForDomainSafe(ciphertext: string, domain: string, fallback: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext; // Legacy plaintext
    try {
      const key = deriveDomainEncryptionKey(this.masterKey, domain);
      return decrypt(ciphertext, key);
    } catch {
      return fallback;
    }
  }

  private encryptGlobal(plaintext: string): string {
    const key = deriveGlobalEncryptionKey(this.masterKey);
    return encrypt(plaintext, key);
  }

  private decryptGlobal(ciphertext: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext;
    const key = deriveGlobalEncryptionKey(this.masterKey);
    return decrypt(ciphertext, key);
    // GCM auth failure THROWS — tampered data must not be silently accepted.
  }

  private decryptGlobalSafe(ciphertext: string, fallback: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext;
    try {
      const key = deriveGlobalEncryptionKey(this.masterKey);
      return decrypt(ciphertext, key);
    } catch {
      return fallback;
    }
  }

  private getTamperTracker(): TamperTracker {
    const prefs = this.getPreferences();
    let tracker = prefs.custom.tamperTracker as TamperTracker | undefined;
    if (!tracker) {
      tracker = {
        count: 0,
        lastTamper: null,
        sessionId: generateULID(),
      };
      this.updatePreferences({ custom: { tamperTracker: tracker } });
    }
    return tracker;
  }

  private updateTamperTracker(updates: Partial<Omit<TamperTracker, 'sessionId'>>): void {
    const prefs = this.getPreferences();
    const tracker = this.getTamperTracker();
    const newTracker = { ...tracker, ...updates };
    this.updatePreferences({ custom: { tamperTracker: newTracker } });
  }

  // Max tamper audit entries per session — prevents DoS via audit log flooding
  private static readonly MAX_TAMPER_AUDIT_LOGS = 10;

  private handleTamper(scope: string, field: string): void {
    const tracker = this.getTamperTracker();
    const newCount = tracker.count + 1;
    const newLast = new Date().toISOString();
    this.updateTamperTracker({ count: newCount, lastTamper: newLast });

    // Only log the first N tamper events to prevent audit log DoS
    if (newCount <= Ledger.MAX_TAMPER_AUDIT_LOGS) {
      this.logAudit('tamper_detected', [scope], undefined, `field=${field} count=${newCount} session=${tracker.sessionId}`);
    }
    // At threshold, log one final summary entry
    if (newCount === Ledger.MAX_TAMPER_AUDIT_LOGS) {
      this.logAudit('tamper_flood_capped', [scope], undefined,
        `Tamper audit capped at ${Ledger.MAX_TAMPER_AUDIT_LOGS}. Further events suppressed. session=${tracker.sessionId}`);
    }
    // Hard stop at excessive count
    if (newCount >= 50) {
      throw new Error(`Excessive tampering detected in session ${tracker.sessionId}: ${newCount} failures`);
    }
  }

  private safeDecryptGlobal(ciphertext: string, fallback: string, field: string): {value: string, tampered: boolean} {
    if (!isEncrypted(ciphertext)) return {value: ciphertext, tampered: false};
    try {
      const key = deriveGlobalEncryptionKey(this.masterKey);
      const value = decrypt(ciphertext, key);
      zeroBuffer(key);
      return {value, tampered: false};
    } catch {
      this.handleTamper('global', field);
      return {value: fallback, tampered: true};
    }
  }

  private safeDecryptForDomain(ciphertext: string, domain: string, fallback: string, field: string): {value: string, tampered: boolean} {
    if (!isEncrypted(ciphertext)) return {value: ciphertext, tampered: false};
    try {
      const key = deriveDomainEncryptionKey(this.masterKey, domain);
      const value = decrypt(ciphertext, key);
      zeroBuffer(key);
      return {value, tampered: false};
    } catch {
      this.handleTamper(domain, field);
      return {value: fallback, tampered: true};
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

  /**
   * Generate a deterministic pseudonym for a domain name.
   * HMAC ensures same domain always maps to same pseudonym,
   * but the real domain name is not exposed in the database.
   */
  private domainPseudonym(domain: string): string {
    const hmac = crypto.createHmac("sha256", this.masterKey);
    hmac.update(`usrcp-domain-pseudo:${domain}`);
    return "d_" + hmac.digest("hex").slice(0, 12);
  }

  /**
   * Resolve a domain pseudonym back to the real domain name.
   * Uses a lookup table stored encrypted in the database.
   */
  private resolveDomain(pseudonym: string): string {
    const row = this.db
      .prepare("SELECT encrypted_name FROM domain_map WHERE pseudonym = ?")
      .get(pseudonym) as any;
    if (!row) return pseudonym; // Fallback
    return this.decryptGlobal(row.encrypted_name) || pseudonym;
  }

  /**
   * Deterministic HMAC of a channel_id for indexed lookup. Uses the
   * master key directly so it is scoped to this ledger but not to any
   * domain — channel_ids cross domain boundaries (a #general channel
   * may carry "coding" and "personal" messages interleaved).
   */
  private channelIdHash(channelId: string): string {
    return crypto
      .createHmac("sha256", this.masterKey)
      .update(`usrcp-channel-id:${channelId}`)
      .digest("hex");
  }

  /**
   * Ensure a domain mapping exists.
   */
  private ensureDomainMapping(domain: string): string {
    const pseudo = this.domainPseudonym(domain);
    const existing = this.db
      .prepare("SELECT pseudonym FROM domain_map WHERE pseudonym = ?")
      .get(pseudo);
    if (!existing) {
      this.db
        .prepare("INSERT OR IGNORE INTO domain_map (pseudonym, encrypted_name) VALUES (?, ?)")
        .run(pseudo, this.encryptGlobal(domain));
    }
    return pseudo;
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
      CREATE INDEX IF NOT EXISTS idx_projects_status ON active_projects(status);

      CREATE TABLE IF NOT EXISTS domain_map (
        pseudonym TEXT PRIMARY KEY,
        encrypted_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        agent_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        scopes_accessed TEXT,
        event_ids TEXT,
        detail TEXT,
        response_size_bytes INTEGER DEFAULT 0,
        integrity_tag TEXT
      );

      -- Stores pending rotation key inside the DB transaction
      -- so key + data are always in sync
      CREATE TABLE IF NOT EXISTS rotation_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pending_key BLOB,
        pending_version INTEGER
      );
      INSERT OR IGNORE INTO rotation_state (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS blind_index (
        event_id TEXT NOT NULL,
        token TEXT NOT NULL,
        domain TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_blind_token ON blind_index(token, domain);
      CREATE INDEX IF NOT EXISTS idx_blind_event ON blind_index(event_id);

      -- Schemaless facts: encrypted free-form (namespace, key, value) triples
      -- per domain. namespace and key are encrypted with random IVs so they
      -- cannot be used for lookup directly — ns_key_hash is a deterministic
      -- HMAC over (namespace || key) using the domain blind-index key.
      CREATE TABLE IF NOT EXISTS schemaless_facts (
        fact_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        ns_key_hash TEXT NOT NULL,
        namespace TEXT NOT NULL,
        "key" TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_facts_domain ON schemaless_facts(domain);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_nskey ON schemaless_facts(domain, ns_key_hash);

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

    // v0.1.3 migration: add integrity_tag to audit_log
    try {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN integrity_tag TEXT");
    } catch {
      // Column already exists
    }

    // v0.1.3: Drop FTS5 table — replaced by blind index to prevent plaintext leakage
    this.db.exec("DROP TABLE IF EXISTS timeline_fts");

    // v0.2.0 migration: add version columns for optimistic concurrency
    for (const tbl of ["core_identity", "global_preferences", "domain_context", "schemaless_facts"]) {
      try {
        this.db.exec(`ALTER TABLE ${tbl} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
      } catch {
        // Column already exists
      }
    }

    // v0.2.1 migration: platform-adapter columns on timeline_events.
    //   channel_id / thread_id / external_user_id : encrypted with global key
    //   channel_hash : deterministic HMAC(channel_id) for by-channel lookup
    // New columns default to NULL; rowToEvent treats null-or-empty as "unset"
    // and does not attempt to decrypt.
    for (const col of ["channel_id", "thread_id", "external_user_id", "channel_hash"]) {
      try {
        this.db.exec(`ALTER TABLE timeline_events ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists
      }
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_channel_hash ON timeline_events(channel_hash) WHERE channel_hash IS NOT NULL"
    );

    // Rebuild blind index if empty but events exist
    const blindCount = this.db
      .prepare("SELECT COUNT(*) as c FROM blind_index")
      .get() as any;
    const eventCount = this.db
      .prepare("SELECT COUNT(*) as c FROM timeline_events")
      .get() as any;
    if (blindCount.c === 0 && eventCount.c > 0) {
      this.rebuildBlindIndex();
    }
  }

  private rebuildBlindIndex(): void {
    this.db.exec("DELETE FROM blind_index");
    const events = this.db
      .prepare("SELECT event_id, summary, intent, tags, domain FROM timeline_events")
      .all() as any[];
    const insertToken = this.db.prepare(
      "INSERT INTO blind_index (event_id, token, domain) VALUES (?, ?, ?)"
    );
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        try {
          const realDomain = this.resolveDomain(event.domain);
          const summary = this.decryptForDomain(event.summary || "", realDomain);
          const intent = this.decryptForDomain(event.intent || "", realDomain);
          const tagsDecrypted = this.decryptForDomain(event.tags || "[]", realDomain);
          const tagsArray = safeJsonParse<string[]>(tagsDecrypted, []);
          const searchableText = [summary, intent, ...tagsArray].join(" ");
          const tokens = this.getBlindTokens(searchableText, realDomain);
          for (const token of tokens) {
            insertToken.run(event.event_id, token, event.domain); // Store with pseudonym
          }
        } catch {
          // Tampered / unreadable event — skip blind tokens for it.
          // The row itself is preserved for audit; searches will miss it.
        }
      }
    });
    transaction();
  }

  /**
   * Convert a database row to a TimelineEvent.
   * GCM failures are caught PER FIELD — a tampered field does not crash the
   * entire read. Tampered fields are replaced with "[TAMPERED]" and the event
   * is flagged. This is the correct middle ground between silent suppression
   * (old behavior) and hard crash (previous fix).
   */
  private rowToEvent(row: any): TimelineEvent & { tampered?: boolean } {
    const domainPseudo = row.domain;
    const domain = this.resolveDomain(domainPseudo);
    let tampered = false;

    const safeDecrypt = (val: string | null, fallback: string, field: string): {value: string, tampered: boolean} => {
      if (!val) return {value: fallback, tampered: false};
      return this.safeDecryptForDomain(val, domain, fallback, field);
    };

    let eventTampered = false;

    const platformRes = safeDecrypt(row.platform, "unknown", 'platform');
    eventTampered ||= platformRes.tampered;
    const summaryRes = safeDecrypt(row.summary, "[TAMPERED]", 'summary');
    eventTampered ||= summaryRes.tampered;
    const intentRes = row.intent ? safeDecrypt(row.intent, "[TAMPERED]", 'intent') : {value: '', tampered: false};
    eventTampered ||= intentRes.tampered;
    const outcomeRes = row.outcome ? safeDecrypt(row.outcome, "failed", 'outcome') : {value: '', tampered: false};
    eventTampered ||= outcomeRes.tampered;
    const detailRes = safeDecrypt(row.detail || "{}", "{}", 'detail');
    eventTampered ||= detailRes.tampered;
    const artifactsRes = safeDecrypt(row.artifacts || "[]", "[]", 'artifacts');
    eventTampered ||= artifactsRes.tampered;
    const tagsRes = safeDecrypt(row.tags || "[]", "[]", 'tags');
    eventTampered ||= tagsRes.tampered;
    const sessionRes = row.session_id ? safeDecrypt(row.session_id, '', 'session_id') : {value: '', tampered: false};
    eventTampered ||= sessionRes.tampered;
    const parentRes = row.parent_event_id ? safeDecrypt(row.parent_event_id, '', 'parent_event_id') : {value: '', tampered: false};
    eventTampered ||= parentRes.tampered;

    // Platform-adapter columns (v0.2.1+) — encrypted under global key,
    // not the per-domain key. Use safeDecryptGlobal.
    const channelIdRes = row.channel_id
      ? this.safeDecryptGlobal(row.channel_id, '', 'channel_id')
      : { value: '', tampered: false };
    eventTampered ||= channelIdRes.tampered;
    const threadIdRes = row.thread_id
      ? this.safeDecryptGlobal(row.thread_id, '', 'thread_id')
      : { value: '', tampered: false };
    eventTampered ||= threadIdRes.tampered;
    const externalUserIdRes = row.external_user_id
      ? this.safeDecryptGlobal(row.external_user_id, '', 'external_user_id')
      : { value: '', tampered: false };
    eventTampered ||= externalUserIdRes.tampered;

    const event: TimelineEvent & { tampered?: boolean } = {
      event_id: row.event_id,
      timestamp: row.timestamp,
      platform: platformRes.value,
      domain,
      summary: summaryRes.value,
      intent: intentRes.value || undefined,
      outcome: (outcomeRes.value || undefined) as TimelineEvent["outcome"],
      detail: safeJsonParse(detailRes.value, {}),
      artifacts: safeJsonParse(artifactsRes.value, []),
      tags: safeJsonParse(tagsRes.value, []),
      session_id: sessionRes.value || undefined,
      parent_event_id: parentRes.value || undefined,
      channel_id: channelIdRes.value || undefined,
      thread_id: threadIdRes.value || undefined,
      external_user_id: externalUserIdRes.value || undefined,
    };

    if (eventTampered) {
      event.tampered = true;
    }

    return event;
  }

  // --- Audit Log ---

  private logAudit(
    operation: string,
    scopesOrDomain?: string | string[],
    eventIds?: string[],
    detail?: string,
    responseSize?: number,
    agentId: string = "system"
  ): void {
    const scopes = Array.isArray(scopesOrDomain)
      ? scopesOrDomain.join(",")
      : scopesOrDomain || null;

    // Build the audit entry
    const encAgentId = this.encryptGlobal(agentId);
    const encOperation = this.encryptGlobal(operation);
    const encScopes = scopes ? this.encryptGlobal(scopes) : null;
    const encEventIds = eventIds ? this.encryptGlobal(JSON.stringify(eventIds)) : null;
    const encDetail = detail ? this.encryptGlobal(detail) : null;

    // HMAC integrity tag — proves the audit entry was written by this ledger
    // and has not been tampered with. Covers all encrypted fields.
    const integrityPayload = [encAgentId, encOperation, encScopes || "", encEventIds || "", encDetail || ""].join("|");
    const globalKey = deriveGlobalEncryptionKey(this.masterKey);
    const integrityTag = crypto.createHmac("sha256", globalKey).update(integrityPayload).digest("hex").slice(0, 32);
    zeroBuffer(globalKey);

    this.db
      .prepare(
        `INSERT INTO audit_log (agent_id, operation, scopes_accessed, event_ids, detail, response_size_bytes, integrity_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(encAgentId, encOperation, encScopes, encEventIds, encDetail, responseSize || 0, integrityTag);
  }

  getAuditLog(limit: number = 100): any[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as any[];

    const globalKey = deriveGlobalEncryptionKey(this.masterKey);

    const results = rows.map((row) => {
      let entryTampered = false;
      let verified = true;

      if (row.integrity_tag) {
        try {
          const payload = [
            row.agent_id, row.operation,
            row.scopes_accessed || "", row.event_ids || "", row.detail || "",
          ].join("|");
          const expected = crypto.createHmac("sha256", globalKey).update(payload).digest("hex").slice(0, 32);
          const tagBuf = Buffer.from(row.integrity_tag);
          const expectedBuf = Buffer.from(expected);
          if (tagBuf.length === expectedBuf.length) {
            verified = crypto.timingSafeEqual(tagBuf, expectedBuf);
          } else {
            verified = false;
          }
          if (!verified) {
            this.handleTamper('audit', `integrity_${row.id}`);
            entryTampered = true;
          }
        } catch {
          verified = false;
          this.handleTamper('audit', `integrity_error_${row.id}`);
          entryTampered = true;
        }
      }

      const agentRes = this.safeDecryptGlobal(row.agent_id || "", '', 'agent_id');
      entryTampered ||= agentRes.tampered;
      const opRes = this.safeDecryptGlobal(row.operation || "", '', 'operation');
      entryTampered ||= opRes.tampered;
      const scopesRes = row.scopes_accessed ? this.safeDecryptGlobal(row.scopes_accessed, '', 'scopes_accessed') : {value: null as any, tampered: false};
      entryTampered ||= scopesRes.tampered;
      const eventsRes = row.event_ids ? this.safeDecryptGlobal(row.event_ids, '', 'event_ids') : {value: null as any, tampered: false};
      entryTampered ||= eventsRes.tampered;
      const detailRes = row.detail ? this.safeDecryptGlobal(row.detail, '', 'detail') : {value: null as any, tampered: false};
      entryTampered ||= detailRes.tampered;

      return {
        id: row.id,
        timestamp: row.timestamp,
        agent_id: agentRes.value,
        operation: opRes.value,
        scopes_accessed: scopesRes.value || null,
        event_ids: eventsRes.value || null,
        detail: detailRes.value || null,
        response_size_bytes: row.response_size_bytes,
        integrity_verified: verified,
        tampered: entryTampered,
      };
    });

    zeroBuffer(globalKey);

    return results;
  }

  // --- Core Identity ---

  getIdentity(): CoreIdentity & {tampered?: boolean; version: number} {
    const row = this.db
      .prepare("SELECT * FROM core_identity WHERE id = 1")
      .get() as any;
    let tampered = false;

    const nameRes = this.safeDecryptGlobal(row.display_name || "", '', 'display_name');
    tampered ||= nameRes.tampered;
    const rolesRes = this.safeDecryptGlobal(row.roles || "[]", '[]', 'roles');
    const roles = safeJsonParse(rolesRes.value, []);
    tampered ||= rolesRes.tampered;
    const expertiseRes = this.safeDecryptGlobal(row.expertise_domains || "[]", '[]', 'expertise_domains');
    const expertise = safeJsonParse(expertiseRes.value, []);
    tampered ||= expertiseRes.tampered;
    const styleRes = this.safeDecryptGlobal(row.communication_style || "concise", 'concise', 'communication_style');
    tampered ||= styleRes.tampered;

    const result: CoreIdentity & {tampered?: boolean; version: number} = {
      display_name: nameRes.value,
      roles,
      expertise_domains: expertise,
      communication_style: styleRes.value as CoreIdentity["communication_style"],
      version: row.version ?? 1,
    };

    if (tampered) result.tampered = true;

    return result;
  }

  private checkExpectedVersion(
    scope: string,
    currentVersion: number,
    expectedVersion: number | undefined,
    target?: string
  ): void {
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflictError(scope, currentVersion, expectedVersion, target);
    }
  }

  updateIdentity(identity: Partial<CoreIdentity>, expectedVersion?: number): number {
    const current = this.getIdentity();
    this.checkExpectedVersion("core_identity", current.version, expectedVersion);
    const merged = { ...current, ...identity };
    const newVersion = current.version + 1;
    this.db
      .prepare(
        `UPDATE core_identity SET
          display_name = ?,
          roles = ?,
          expertise_domains = ?,
          communication_style = ?,
          version = ?,
          updated_at = datetime('now')
        WHERE id = 1`
      )
      .run(
        this.encryptGlobal(merged.display_name),
        this.encryptGlobal(JSON.stringify(merged.roles)),
        this.encryptGlobal(JSON.stringify(merged.expertise_domains)),
        this.encryptGlobal(merged.communication_style),
        newVersion
      );
    this.logAudit("update_identity");
    return newVersion;
  }

  // --- Global Preferences ---

  getPreferences(): GlobalPreferences & {tampered?: boolean; version: number} {
    const row = this.db
      .prepare("SELECT * FROM global_preferences WHERE id = 1")
      .get() as any;
    let tampered = false;

    const langRes = this.safeDecryptGlobal(row.language || "en", 'en', 'language');
    tampered ||= langRes.tampered;
    const tzRes = this.safeDecryptGlobal(row.timezone || "UTC", 'UTC', 'timezone');
    tampered ||= tzRes.tampered;
    const formatRes = this.safeDecryptGlobal(row.output_format || "markdown", 'markdown', 'output_format');
    tampered ||= formatRes.tampered;
    const verbRes = this.safeDecryptGlobal(row.verbosity || "standard", 'standard', 'verbosity');
    tampered ||= verbRes.tampered;
    const customRes = this.safeDecryptGlobal(row.custom || "{}", '{}', 'custom');
    const custom = safeJsonParse(customRes.value, {});
    tampered ||= customRes.tampered;

    const result: GlobalPreferences & {tampered?: boolean; version: number} = {
      language: langRes.value,
      timezone: tzRes.value,
      output_format: formatRes.value as GlobalPreferences["output_format"],
      verbosity: verbRes.value as GlobalPreferences["verbosity"],
      custom,
      version: row.version ?? 1,
    };

    if (tampered) result.tampered = true;

    return result;
  }

  updatePreferences(prefs: Partial<GlobalPreferences>, expectedVersion?: number): number {
    const current = this.getPreferences();
    this.checkExpectedVersion("global_preferences", current.version, expectedVersion);
    const merged = { ...current, ...prefs };
    if (prefs.custom) {
      merged.custom = { ...current.custom, ...prefs.custom };
    }
    const newVersion = current.version + 1;
    this.db
      .prepare(
        `UPDATE global_preferences SET
          language = ?,
          timezone = ?,
          output_format = ?,
          verbosity = ?,
          custom = ?,
          version = ?,
          updated_at = datetime('now')
        WHERE id = 1`
      )
      .run(
        this.encryptGlobal(merged.language),
        this.encryptGlobal(merged.timezone),
        this.encryptGlobal(merged.output_format),
        this.encryptGlobal(merged.verbosity),
        this.encryptGlobal(JSON.stringify(merged.custom)),
        newVersion
      );
    this.logAudit("update_preferences");
    return newVersion;
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
    idempotencyKey?: string,
    agentId: string = "system"
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
    const domainPseudo = this.ensureDomainMapping(event.domain);

    const maxSeq = this.db
      .prepare(
        "SELECT COALESCE(MAX(ledger_sequence), 0) as max_seq FROM timeline_events"
      )
      .get() as any;
    const ledger_sequence = maxSeq.max_seq + 1;

    // Encrypt ALL fields with domain-scoped key
    const detailPlain = JSON.stringify(event.detail || {});
    const artifactsPlain = JSON.stringify(event.artifacts || []);
    const tagsPlain = JSON.stringify(event.tags || []);

    const detailEncrypted = this.encryptForDomain(detailPlain, event.domain);
    const artifactsEncrypted = this.encryptForDomain(artifactsPlain, event.domain);
    const tagsEncrypted = this.encryptForDomain(tagsPlain, event.domain);
    const summaryEncrypted = this.encryptForDomain(event.summary, event.domain);
    const intentEncrypted = event.intent
      ? this.encryptForDomain(event.intent, event.domain)
      : null;
    const outcomeEncrypted = event.outcome
      ? this.encryptForDomain(event.outcome, event.domain)
      : null;
    const platformEncrypted = this.encryptForDomain(platform, event.domain);
    const sessionIdEncrypted = event.session_id
      ? this.encryptForDomain(event.session_id, event.domain)
      : null;
    const parentIdEncrypted = event.parent_event_id
      ? this.encryptForDomain(event.parent_event_id, event.domain)
      : null;
    // Platform-adapter columns. channel_id/thread_id/external_user_id are
    // encrypted with the global key (not the per-domain key) because the
    // same channel surface can produce events across multiple domains,
    // and we want a single deterministic hash space for channel_hash.
    const channelIdEncrypted = event.channel_id
      ? this.encryptGlobal(event.channel_id)
      : null;
    const threadIdEncrypted = event.thread_id
      ? this.encryptGlobal(event.thread_id)
      : null;
    const externalUserIdEncrypted = event.external_user_id
      ? this.encryptGlobal(event.external_user_id)
      : null;
    const channelHash = event.channel_id
      ? this.channelIdHash(event.channel_id)
      : null;

    this.db
      .prepare(
        `INSERT INTO timeline_events
          (event_id, timestamp, platform, domain, summary, intent, outcome, detail, artifacts, tags, session_id, parent_event_id, ledger_sequence, idempotency_key, channel_id, thread_id, external_user_id, channel_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event_id,
        timestamp,
        platformEncrypted,
        domainPseudo,
        summaryEncrypted,
        intentEncrypted,
        outcomeEncrypted,
        detailEncrypted,
        artifactsEncrypted,
        tagsEncrypted,
        sessionIdEncrypted,
        parentIdEncrypted,
        ledger_sequence,
        idempotencyKey || null,
        channelIdEncrypted,
        threadIdEncrypted,
        externalUserIdEncrypted,
        channelHash
      );

    // Store blind index tokens for search (no plaintext leakage)
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
      insertToken.run(event_id, token, domainPseudo);
    }

    this.logAudit("append_event", domainPseudo, [event_id], undefined, undefined, agentId);

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
      const pseudonyms = options.domains.map((d) => this.domainPseudonym(d));
      const placeholders = pseudonyms.map(() => "?").join(", ");
      conditions.push(`domain IN (${placeholders})`);
      params.push(...pseudonyms);
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

    // Determine which domains to search (using real domain names for key derivation)
    const realDomains = options?.domain
      ? [options.domain]
      : this.getAllRealDomains();

    if (realDomains.length === 0) return [];

    // Collect matches per domain (OR across domains, AND across tokens within a domain)
    // An event must match ALL search tokens within its own domain.
    const allMatchingEventIds = new Set<string>();

    for (const domain of realDomains) {
      const pseudo = this.domainPseudonym(domain);
      const searchTokens = this.getSearchTokens(query, domain);
      if (searchTokens.length === 0) continue;

      // For each token, find matching events in this domain
      let domainMatches: Set<string> | null = null;
      for (const token of searchTokens) {
        const matches = this.db
          .prepare(
            "SELECT DISTINCT event_id FROM blind_index WHERE token = ? AND domain = ?"
          )
          .all(token, pseudo) as any[];
        const tokenMatches = new Set(matches.map((m: any) => m.event_id));

        if (domainMatches === null) {
          domainMatches = tokenMatches;
        } else {
          // AND within domain: event must match ALL query tokens
          const current: Set<string> = domainMatches;
          domainMatches = new Set(
            [...current].filter((id) => tokenMatches.has(id))
          );
        }
      }

      // OR across domains: add this domain's matches to the global set
      if (domainMatches) {
        for (const id of domainMatches) {
          allMatchingEventIds.add(id);
        }
      }
    }

    if (allMatchingEventIds.size === 0) return [];
    const matchingEventIds = allMatchingEventIds;

    // Fetch the actual events
    const ids = [...matchingEventIds];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM timeline_events
        WHERE event_id IN (${placeholders})
        ORDER BY ledger_sequence DESC
        LIMIT ?`
      )
      .all(...ids, limit) as any[];

    const results = rows.map((r) => this.rowToEvent(r));
    this.logAudit("search_timeline", undefined, results.map((e) => e.event_id), `query_length=${query.length}`);
    return results;
  }

  private getAllRealDomains(): string[] {
    const rows = this.db
      .prepare("SELECT pseudonym, encrypted_name FROM domain_map")
      .all() as any[];
    return rows.map((r: any) => this.decryptGlobal(r.encrypted_name)).filter(Boolean);
  }

  /**
   * Fetch recent events tagged with the given channel_id. Looks up via
   * the deterministic channel_hash (HMAC of channel_id under the master
   * key) — the channel_id ciphertext itself uses a random IV and can't
   * be queried directly.
   */
  getRecentEventsByChannel(channelId: string, limit: number = 10): TimelineEvent[] {
    const hash = this.channelIdHash(channelId);
    const rows = this.db
      .prepare(
        `SELECT * FROM timeline_events
         WHERE channel_hash = ?
         ORDER BY ledger_sequence DESC
         LIMIT ?`
      )
      .all(hash, limit) as any[];
    const results = rows.map((r) => this.rowToEvent(r));
    this.logAudit("get_events_by_channel", undefined, results.map((e) => e.event_id), undefined, JSON.stringify(results).length);
    return results;
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
    // Write encrypted empty values to maintain encryption-at-rest consistency
    const compactStmt = this.db.prepare(
      `UPDATE timeline_events
      SET detail = ?, artifacts = ?
      WHERE event_id = ?`
    );

    let compacted = 0;
    const transaction = this.db.transaction(() => {
      for (const event of oldEvents) {
        // Need the domain to encrypt with the correct key
        const row = this.db
          .prepare("SELECT domain FROM timeline_events WHERE event_id = ?")
          .get(event.event_id) as any;
        if (row) {
          const realDomain = this.resolveDomain(row.domain);
          const emptyDetail = this.encryptForDomain("{}", realDomain);
          const emptyArtifacts = this.encryptForDomain("[]", realDomain);
          compactStmt.run(emptyDetail, emptyArtifacts, event.event_id);
          compacted++;
        }
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

  getProjects(status?: string): (ActiveProject & {tampered?: boolean})[] {
    // All project fields are encrypted — fetch all and filter in memory
    const rows = this.db
      .prepare("SELECT * FROM active_projects ORDER BY last_touched DESC")
      .all() as any[];

    const projects = rows.map((row: any) => {
      let tampered = false;

      const nameRes = this.safeDecryptGlobal(row.name || "", '', 'project_name');
      tampered ||= nameRes.tampered;
      const domainRes = this.safeDecryptGlobal(row.domain || "", '', 'project_domain');
      tampered ||= domainRes.tampered;
      const statusRes = this.safeDecryptGlobal(row.status || "active", 'active', 'project_status');
      tampered ||= statusRes.tampered;
      const summaryRes = this.safeDecryptGlobal(row.summary || "", '', 'project_summary');
      tampered ||= summaryRes.tampered;

      const result: ActiveProject & {tampered?: boolean} = {
        project_id: row.project_id,
        name: nameRes.value,
        domain: domainRes.value,
        status: statusRes.value as ActiveProject["status"],
        last_touched: row.last_touched,
        summary: summaryRes.value,
      };

      if (tampered) result.tampered = true;

      return result;
    });

    if (status) {
      return projects.filter((p) => p.status === status);
    }
    return projects;
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
        this.encryptGlobal(project.name),
        this.encryptGlobal(project.domain),
        this.encryptGlobal(project.status),
        project.last_touched || new Date().toISOString(),
        this.encryptGlobal(project.summary)
      );
    this.logAudit("upsert_project", undefined, [project.project_id]);
  }

  // --- Domain Context ---

  getDomainContext(
    domains?: string[]
  ): Record<string, Record<string, unknown>> {
    let rows: any[];
    if (domains && domains.length > 0) {
      const pseudonyms = domains.map((d) => this.domainPseudonym(d));
      const placeholders = pseudonyms.map(() => "?").join(", ");
      rows = this.db
        .prepare(
          `SELECT * FROM domain_context WHERE domain IN (${placeholders})`
        )
        .all(...pseudonyms) as any[];
    } else {
      rows = this.db.prepare("SELECT * FROM domain_context").all() as any[];
    }
    const result: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const realDomain = this.resolveDomain(row.domain);
      const res = this.safeDecryptForDomain(row.context || "{}", realDomain, "{}", `domain_context_${realDomain}`);
      result[realDomain] = safeJsonParse(res.value, {});
      // if (res.tampered) { /* flag if needed */ }
    }
    return result;
  }

  getDomainContextVersion(domain: string): number {
    const pseudo = this.domainPseudonym(domain);
    const row = this.db
      .prepare("SELECT version FROM domain_context WHERE domain = ?")
      .get(pseudo) as { version: number } | undefined;
    return row?.version ?? 0; // 0 = domain context doesn't exist yet
  }

  upsertDomainContext(
    domain: string,
    context: Record<string, unknown>,
    expectedVersion?: number
  ): number {
    const pseudo = this.ensureDomainMapping(domain);
    const currentVersion = this.getDomainContextVersion(domain);
    this.checkExpectedVersion("domain_context", currentVersion, expectedVersion, domain);
    const existing = this.getDomainContext([domain]);
    const merged = { ...(existing[domain] || {}), ...context };
    const encrypted = this.encryptForDomain(JSON.stringify(merged), domain);
    const newVersion = currentVersion + 1;
    this.db
      .prepare(
        `INSERT INTO domain_context (domain, context, version, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(domain) DO UPDATE SET
          context = excluded.context,
          version = excluded.version,
          updated_at = excluded.updated_at`
      )
      .run(pseudo, encrypted, newVersion);
    this.logAudit("update_domain_context", pseudo);
    return newVersion;
  }

  // --- Schemaless Facts ---

  // Max lengths for schemaless fact fields. Cap plaintext before encryption to
  // prevent abuse and keep rows bounded.
  private static readonly MAX_FACT_NAMESPACE = 100;
  private static readonly MAX_FACT_KEY = 200;
  private static readonly MAX_FACT_VALUE_BYTES = 65536;

  /**
   * Deterministic HMAC of (namespace, key) under the domain's blind-index
   * key. Used as the lookup column for schemaless_facts. Domain-scoped so
   * the same (namespace, key) under a different domain maps to a different
   * hash.
   */
  private factLookupHash(domain: string, namespace: string, key: string): string {
    const blindKey = deriveBlindIndexKey(this.masterKey, domain);
    const h = crypto.createHmac("sha256", blindKey);
    // Length-prefix to avoid (ns="a", k="bb") colliding with (ns="ab", k="b")
    h.update(`${namespace.length}:${namespace}|${key.length}:${key}`);
    const tag = h.digest("hex");
    zeroBuffer(blindKey);
    return tag;
  }

  private validateFactInput(namespace: string, key: string, valueSerialized: string): void {
    if (namespace.length === 0) throw new Error("namespace cannot be empty");
    if (key.length === 0) throw new Error("key cannot be empty");
    if (namespace.length > Ledger.MAX_FACT_NAMESPACE)
      throw new Error(`namespace exceeds ${Ledger.MAX_FACT_NAMESPACE} chars`);
    if (key.length > Ledger.MAX_FACT_KEY)
      throw new Error(`key exceeds ${Ledger.MAX_FACT_KEY} chars`);
    if (Buffer.byteLength(valueSerialized, "utf8") > Ledger.MAX_FACT_VALUE_BYTES)
      throw new Error(`value exceeds ${Ledger.MAX_FACT_VALUE_BYTES} bytes`);
  }

  setFact(
    domain: string,
    namespace: string,
    key: string,
    value: unknown,
    opts: { expectedVersion?: number; agentId?: string } = {}
  ): { fact_id: string; created: boolean; updated_at: string; version: number } {
    const agentId = opts.agentId ?? "system";
    const valueSerialized = JSON.stringify(value ?? null);
    this.validateFactInput(namespace, key, valueSerialized);

    const domainPseudo = this.ensureDomainMapping(domain);
    const nsKeyHash = this.factLookupHash(domain, namespace, key);

    const existing = this.db
      .prepare(
        "SELECT fact_id, version FROM schemaless_facts WHERE domain = ? AND ns_key_hash = ?"
      )
      .get(domainPseudo, nsKeyHash) as { fact_id: string; version: number } | undefined;

    this.checkExpectedVersion(
      "schemaless_facts",
      existing?.version ?? 0,
      opts.expectedVersion,
      `${domain}/${namespace}/${key}`
    );

    const namespaceEnc = this.encryptForDomain(namespace, domain);
    const keyEnc = this.encryptForDomain(key, domain);
    const valueEnc = this.encryptForDomain(valueSerialized, domain);

    if (existing) {
      const newVersion = existing.version + 1;
      this.db
        .prepare(
          `UPDATE schemaless_facts
          SET namespace = ?, "key" = ?, value = ?, version = ?, updated_at = datetime('now')
          WHERE fact_id = ?`
        )
        .run(namespaceEnc, keyEnc, valueEnc, newVersion, existing.fact_id);
      const updated = this.db
        .prepare("SELECT updated_at FROM schemaless_facts WHERE fact_id = ?")
        .get(existing.fact_id) as { updated_at: string };
      this.logAudit("set_fact", domainPseudo, [existing.fact_id], undefined, undefined, agentId);
      return { fact_id: existing.fact_id, created: false, updated_at: updated.updated_at, version: newVersion };
    }

    const factId = generateULID();
    this.db
      .prepare(
        `INSERT INTO schemaless_facts (fact_id, domain, ns_key_hash, namespace, "key", value, version)
        VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(factId, domainPseudo, nsKeyHash, namespaceEnc, keyEnc, valueEnc);
    const created = this.db
      .prepare("SELECT created_at FROM schemaless_facts WHERE fact_id = ?")
      .get(factId) as { created_at: string };
    this.logAudit("set_fact", domainPseudo, [factId], undefined, undefined, agentId);
    return { fact_id: factId, created: true, updated_at: created.created_at, version: 1 };
  }

  getFact(domain: string, namespace: string, key: string): SchemaFact | null {
    const domainPseudo = this.domainPseudonym(domain);
    const nsKeyHash = this.factLookupHash(domain, namespace, key);
    const row = this.db
      .prepare(
        "SELECT * FROM schemaless_facts WHERE domain = ? AND ns_key_hash = ?"
      )
      .get(domainPseudo, nsKeyHash) as any;
    if (!row) return null;
    return this.rowToFact(row);
  }

  listFacts(domain: string, namespace?: string): SchemaFact[] {
    const domainPseudo = this.domainPseudonym(domain);
    const rows = this.db
      .prepare(
        "SELECT * FROM schemaless_facts WHERE domain = ? ORDER BY updated_at DESC"
      )
      .all(domainPseudo) as any[];
    if (namespace === undefined) {
      return rows.map((r) => this.rowToFact(r));
    }
    // Namespace filter: decrypt namespace first and skip non-matches before
    // paying to decrypt the other two columns. Saves ~2/3 of the GCM work
    // when most rows don't match the filter.
    const realDomain = this.resolveDomain(domainPseudo);
    const matches: SchemaFact[] = [];
    for (const r of rows) {
      const ns = this.decryptForDomain(r.namespace, realDomain);
      if (ns !== namespace) continue;
      matches.push(this.rowToFact(r));
    }
    return matches;
  }

  deleteFact(factId: string, agentId: string = "system"): boolean {
    const row = this.db
      .prepare("SELECT domain FROM schemaless_facts WHERE fact_id = ?")
      .get(factId) as { domain: string } | undefined;
    if (!row) return false;
    const result = this.db
      .prepare("DELETE FROM schemaless_facts WHERE fact_id = ?")
      .run(factId);
    this.logAudit("delete_fact", row.domain, [factId], undefined, undefined, agentId);
    return result.changes > 0;
  }

  private rowToFact(row: any): SchemaFact {
    const realDomain = this.resolveDomain(row.domain);
    const namespace = this.decryptForDomain(row.namespace, realDomain);
    const key = this.decryptForDomain(row.key, realDomain);
    const valueRaw = this.decryptForDomain(row.value, realDomain);
    return {
      fact_id: row.fact_id,
      domain: realDomain,
      namespace,
      key,
      value: safeJsonParse<unknown>(valueRaw, null),
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version ?? 1,
    };
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
    const domainPseudos = this.db
      .prepare("SELECT DISTINCT domain FROM timeline_events")
      .all() as any[];
    // Platforms are encrypted — decrypt using resolved domain names
    const allPlatforms = this.db
      .prepare("SELECT DISTINCT platform, domain FROM timeline_events")
      .all() as any[];
    const platformSet = new Set<string>();
    for (const row of allPlatforms) {
      const realDomain = this.resolveDomain(row.domain);
      const decrypted = this.decryptForDomain(row.platform || "", realDomain);
      if (decrypted) platformSet.add(decrypted);
    }

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
      domains: domainPseudos.map((d: any) => this.resolveDomain(d.domain)),
      platforms: [...platformSet],
      db_size_bytes: dbSize?.size || 0,
      audit_log_entries: auditCount.count,
      encryption_enabled: true,
    };
  }

  // --- Sync helpers (encrypted-row access for usrcp-cloud client) ---

  /**
   * Return raw encrypted event rows with ledger_sequence > minSeq. The
   * sync client forwards these verbatim to the hosted ledger — none of
   * the encrypted columns are decrypted here.
   */
  listEncryptedEventsAbove(minSeq: number, limit: number = 500): Array<{
    event_id: string;
    ledger_sequence: number;
    timestamp: string;
    domain: string;
    platform: string | null;
    summary: string;
    intent: string | null;
    outcome: string | null;
    detail: string | null;
    artifacts: string | null;
    tags: string | null;
    session_id: string | null;
    parent_event_id: string | null;
    idempotency_key: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT event_id, ledger_sequence, timestamp, domain, platform,
                summary, intent, outcome, detail, artifacts, tags,
                session_id, parent_event_id, idempotency_key
         FROM timeline_events
         WHERE ledger_sequence > ?
         ORDER BY ledger_sequence ASC
         LIMIT ?`
      )
      .all(minSeq, limit) as any[];
  }

  getMaxSequence(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ledger_sequence), 0) AS max_seq FROM timeline_events")
      .get() as { max_seq: number };
    return Number(row.max_seq ?? 0);
  }

  /**
   * Insert events pulled from the hosted ledger. Each event is assigned
   * the next local sequence. Events already present by event_id are
   * skipped. Blind-index tokens are NOT populated — pulled events are
   * searchable only after the next full rebuild (next ledger open).
   * Returns the number of events actually inserted.
   */
  applyPulledEvents(events: Array<{
    event_id: string;
    client_timestamp: string;
    domain_pseudonym: string;
    platform_enc?: string | null;
    summary_enc: string;
    intent_enc?: string | null;
    outcome_enc?: string | null;
    detail_enc?: string | null;
    artifacts_enc?: string | null;
    tags_enc?: string | null;
    session_id_enc?: string | null;
    parent_event_id_enc?: string | null;
  }>): number {
    const existsStmt = this.db.prepare(
      "SELECT 1 FROM timeline_events WHERE event_id = ? LIMIT 1"
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO timeline_events
        (event_id, timestamp, platform, domain, summary, intent, outcome,
         detail, artifacts, tags, session_id, parent_event_id,
         ledger_sequence, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let applied = 0;
    const txn = this.db.transaction(() => {
      let localSeq = this.getMaxSequence();
      for (const e of events) {
        if (existsStmt.get(e.event_id)) continue;
        localSeq += 1;
        insertStmt.run(
          e.event_id,
          e.client_timestamp,
          e.platform_enc ?? "",
          e.domain_pseudonym,
          e.summary_enc,
          e.intent_enc ?? null,
          e.outcome_enc ?? null,
          e.detail_enc ?? null,
          e.artifacts_enc ?? null,
          e.tags_enc ?? null,
          e.session_id_enc ?? null,
          e.parent_event_id_enc ?? null,
          localSeq,
          `cloud:${e.event_id}`
        );
        applied += 1;
      }
    });
    txn();
    return applied;
  }

  // --- Key Rotation ---

  /**
   * Rotate the master encryption key and re-encrypt all data.
   * This is an atomic operation — either everything is re-encrypted or nothing is.
   */
  rotateKey(passphrase?: string): { version: number; reencrypted: number; skipped: number } {
    // Phase 1: Prepare new key material WITHOUT writing to disk
    const { oldKey, newKey, version, pendingFiles } = prepareKeyRotation(this.masterKey, passphrase);
    let reencrypted = 0;
    // Rotation and tampered rows: if a row fails to decrypt with the old key
    // (GCM auth failure from tampering, corruption, or key mismatch) it is
    // unrecoverable — the plaintext cannot be produced to re-encrypt. Rather
    // than failing the entire rotation, we log a warning, leave the row in
    // place, and continue. The row remains unreadable under the new key too,
    // but its presence is preserved so external audits can see it.
    // Callers are informed via the returned `skipped` count and an
    // audit log entry.
    let skipped = 0;

    const transaction = this.db.transaction(() => {
      const oldGlobalKey = deriveGlobalEncryptionKey(oldKey);
      const newGlobalKey = deriveGlobalEncryptionKey(newKey);

      const reencGlobal = (val: string) => {
        const plain = isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
        return encrypt(plain, newGlobalKey);
      };

      // Build old pseudonym → real domain name mapping FIRST
      const domainMaps = this.db.prepare("SELECT pseudonym, encrypted_name FROM domain_map").all() as any[];
      const pseudoToReal = new Map<string, string>();
      const domainNames: string[] = [];
      for (const dm of domainMaps) {
        const realName = isEncrypted(dm.encrypted_name) ? decrypt(dm.encrypted_name, oldGlobalKey) : dm.encrypted_name;
        pseudoToReal.set(dm.pseudonym, realName);
        domainNames.push(realName);
      }

      // Precompute per-domain key material once. Without this, HKDF runs
      // twice per row for events, and twice again per row for facts —
      // O(rows) cost where O(domains) is enough.
      interface DomainKeyBundle {
        oldDomainKey: Buffer;
        newDomainKey: Buffer;
        newBlindKey: Buffer;
        oldPseudo: string;
        newPseudo: string;
      }
      const domainKeyCache = new Map<string, DomainKeyBundle>();
      const pseudoForName = (key: Buffer, name: string) =>
        "d_" + crypto.createHmac("sha256", key).update(`usrcp-domain-pseudo:${name}`).digest("hex").slice(0, 12);
      for (const name of domainNames) {
        domainKeyCache.set(name, {
          oldDomainKey: deriveDomainEncryptionKey(oldKey, name),
          newDomainKey: deriveDomainEncryptionKey(newKey, name),
          newBlindKey: deriveBlindIndexKey(newKey, name),
          oldPseudo: pseudoForName(oldKey, name),
          newPseudo: pseudoForName(newKey, name),
        });
      }

      // Re-encrypt all timeline events AND update their domain pseudonym
      // in a single UPDATE — no separate per-domain pass afterwards.
      const events = this.db
        .prepare("SELECT event_id, domain, summary, intent, outcome, platform, detail, artifacts, tags, session_id, parent_event_id, channel_id, thread_id, external_user_id FROM timeline_events")
        .all() as any[];

      const updateEvent = this.db.prepare(
        `UPDATE timeline_events SET domain=?, summary=?, intent=?, outcome=?, platform=?, detail=?, artifacts=?, tags=?, session_id=?, parent_event_id=?, channel_id=?, thread_id=?, external_user_id=?, channel_hash=? WHERE event_id=?`
      );

      const reencGlobalNullable = (val: string | null): string | null => {
        if (!val) return null;
        const plain = isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
        return encrypt(plain, newGlobalKey);
      };

      const decryptGlobalMaybe = (val: string | null): string | null => {
        if (!val) return null;
        return isEncrypted(val) ? decrypt(val, oldGlobalKey) : val;
      };

      for (const e of events) {
        const realDomain = pseudoToReal.get(e.domain) || e.domain;
        const bundle = domainKeyCache.get(realDomain);
        if (!bundle) continue; // domain not in map — should not happen

        const reenc = (val: string | null) => {
          if (!val) return null;
          const plain = isEncrypted(val) ? decrypt(val, bundle.oldDomainKey) : val;
          return encrypt(plain, bundle.newDomainKey);
        };

        try {
          // Platform-adapter columns use the global key, not the per-domain
          // key. channel_hash is re-derived under the new master key.
          const channelIdPlain = decryptGlobalMaybe(e.channel_id);
          const newChannelHash = channelIdPlain
            ? crypto.createHmac("sha256", newKey).update(`usrcp-channel-id:${channelIdPlain}`).digest("hex")
            : null;

          updateEvent.run(
            bundle.newPseudo,
            reenc(e.summary), reenc(e.intent), reenc(e.outcome), reenc(e.platform),
            reenc(e.detail), reenc(e.artifacts), reenc(e.tags),
            reenc(e.session_id), reenc(e.parent_event_id),
            reencGlobalNullable(e.channel_id),
            reencGlobalNullable(e.thread_id),
            reencGlobalNullable(e.external_user_id),
            newChannelHash,
            e.event_id
          );
          reencrypted++;
        } catch (err) {
          // Any decrypt failure means a field is damaged and the row
          // is unrecoverable. Leave it in place (old ciphertext, old
          // domain pseudo) so external audits can see the damaged row,
          // and continue rotation for the rest of the ledger.
          console.warn(
            `[usrcp] rotateKey: skipping damaged timeline event ${e.event_id}: ${(err as Error).message}`
          );
          skipped++;
        }
      }

      // Now rewrite domain_map with new pseudonyms
      this.db.exec("DELETE FROM domain_map");
      const insertMap = this.db.prepare("INSERT INTO domain_map (pseudonym, encrypted_name) VALUES (?, ?)");
      for (const name of domainNames) {
        const bundle = domainKeyCache.get(name)!;
        insertMap.run(bundle.newPseudo, encrypt(name, newGlobalKey));
      }

      // Re-encrypt domain context with new pseudonyms
      const contexts = this.db.prepare("SELECT domain, context FROM domain_context").all() as any[];
      this.db.exec("DELETE FROM domain_context");
      const insertCtx = this.db.prepare("INSERT INTO domain_context (domain, context, updated_at) VALUES (?, ?, datetime('now'))");
      for (const c of contexts) {
        const realName = pseudoToReal.get(c.domain);
        if (!realName) continue;
        const bundle = domainKeyCache.get(realName)!;
        try {
          const plain = isEncrypted(c.context) ? decrypt(c.context, bundle.oldDomainKey) : c.context;
          insertCtx.run(bundle.newPseudo, encrypt(plain, bundle.newDomainKey));
        } catch (err) {
          // Tampered / corrupted context — leave the old row in place
          // under its old pseudo so it doesn't collide with the rewritten
          // domain_context table.
          console.warn(
            `[usrcp] rotateKey: skipping damaged domain_context for ${c.domain}: ${(err as Error).message}`
          );
          insertCtx.run(c.domain, c.context);
          skipped++;
        }
      }

      // Re-encrypt schemaless_facts using the same per-domain cache.
      const facts = this.db.prepare(
        "SELECT fact_id, domain, namespace, \"key\", value FROM schemaless_facts"
      ).all() as any[];
      const updateFact = this.db.prepare(
        `UPDATE schemaless_facts SET domain = ?, ns_key_hash = ?, namespace = ?, "key" = ?, value = ? WHERE fact_id = ?`
      );
      for (const f of facts) {
        const realDomain = pseudoToReal.get(f.domain) || f.domain;
        const bundle = domainKeyCache.get(realDomain);
        if (!bundle) continue;

        try {
          const nsPlain = isEncrypted(f.namespace) ? decrypt(f.namespace, bundle.oldDomainKey) : f.namespace;
          const keyPlain = isEncrypted(f.key) ? decrypt(f.key, bundle.oldDomainKey) : f.key;
          const valuePlain = isEncrypted(f.value) ? decrypt(f.value, bundle.oldDomainKey) : f.value;

          const newHash = crypto.createHmac("sha256", bundle.newBlindKey)
            .update(`${nsPlain.length}:${nsPlain}|${keyPlain.length}:${keyPlain}`)
            .digest("hex");

          updateFact.run(
            bundle.newPseudo,
            newHash,
            encrypt(nsPlain, bundle.newDomainKey),
            encrypt(keyPlain, bundle.newDomainKey),
            encrypt(valuePlain, bundle.newDomainKey),
            f.fact_id
          );
        } catch (err) {
          // Tampered fact — leave the row in place with old ciphertext
          // and old pseudonym so audits can see it.
          console.warn(
            `[usrcp] rotateKey: skipping damaged fact ${f.fact_id}: ${(err as Error).message}`
          );
          skipped++;
        }
      }

      // Zero the cached per-domain keys. The global keys are zeroed
      // separately in the rotation tail.
      for (const bundle of domainKeyCache.values()) {
        zeroBuffer(bundle.oldDomainKey);
        zeroBuffer(bundle.newDomainKey);
        zeroBuffer(bundle.newBlindKey);
      }

      // Re-encrypt identity
      const identity = this.db.prepare("SELECT * FROM core_identity WHERE id = 1").get() as any;
      this.db.prepare(
        "UPDATE core_identity SET display_name=?, roles=?, expertise_domains=?, communication_style=? WHERE id=1"
      ).run(
        reencGlobal(identity.display_name),
        reencGlobal(identity.roles),
        reencGlobal(identity.expertise_domains),
        reencGlobal(identity.communication_style)
      );

      // Re-encrypt ALL preference fields
      const prefs = this.db.prepare("SELECT * FROM global_preferences WHERE id = 1").get() as any;
      this.db.prepare(
        "UPDATE global_preferences SET language=?, timezone=?, output_format=?, verbosity=?, custom=? WHERE id=1"
      ).run(
        reencGlobal(prefs.language),
        reencGlobal(prefs.timezone),
        reencGlobal(prefs.output_format),
        reencGlobal(prefs.verbosity),
        reencGlobal(prefs.custom)
      );

      // Re-encrypt active_projects
      const projects = this.db.prepare("SELECT * FROM active_projects").all() as any[];
      const updateProject = this.db.prepare(
        "UPDATE active_projects SET name=?, domain=?, status=?, summary=? WHERE project_id=?"
      );
      for (const p of projects) {
        updateProject.run(
          reencGlobal(p.name), reencGlobal(p.domain),
          reencGlobal(p.status), reencGlobal(p.summary), p.project_id
        );
      }

      // Re-encrypt audit_log
      const audits = this.db.prepare("SELECT * FROM audit_log").all() as any[];
      const updateAudit = this.db.prepare(
        "UPDATE audit_log SET agent_id=?, operation=?, scopes_accessed=?, event_ids=?, detail=?, integrity_tag=? WHERE id=?"
      );
      for (const a of audits) {
        const encAgentId = reencGlobal(a.agent_id);
        const encOp = reencGlobal(a.operation);
        const encScopes = a.scopes_accessed ? reencGlobal(a.scopes_accessed) : null;
        const encEvents = a.event_ids ? reencGlobal(a.event_ids) : null;
        const encDetail = a.detail ? reencGlobal(a.detail) : null;
        // Recompute integrity tag with new key
        const payload = [encAgentId, encOp, encScopes || "", encEvents || "", encDetail || ""].join("|");
        const tag = crypto.createHmac("sha256", newGlobalKey).update(payload).digest("hex").slice(0, 32);
        updateAudit.run(encAgentId, encOp, encScopes, encEvents, encDetail, tag, a.id);
      }

      // Store new key in rotation_state — same transaction as re-encryption
      // If crash: entire transaction rolls back, old key + old data intact
      this.db.prepare(
        "UPDATE rotation_state SET pending_key = ?, pending_version = ? WHERE id = 1"
      ).run(newKey, version);
    });

    // Phase 2: Execute re-encryption + store new key in single atomic transaction.
    // If crash: transaction rolls back, old key + old data, nothing lost.
    transaction();

    // Phase 3: Write key files to disk. If crash here, on next startup
    // we detect pending_key in rotation_state and recover.
    commitKeyRotation(pendingFiles);

    // Phase 4: Clear pending state — rotation complete
    this.db.prepare(
      "UPDATE rotation_state SET pending_key = NULL, pending_version = NULL WHERE id = 1"
    ).run();

    // Update in-memory key
    const oldMasterKey = this.masterKey;
    this.masterKey = newKey;
    zeroBuffer(oldMasterKey);

    // Reset tamper tracker
    const tracker = this.getTamperTracker();
    if (tracker.count > 0) {
      this.updatePreferences({ custom: { tamperTracker: { ...tracker, count: 0, lastTamper: null } } });
      this.logAudit("key_rotation_reset_tamper", undefined, undefined, `old_count=${tracker.count}`);
    }

    // Rebuild blind index with new key
    this.rebuildBlindIndex();

    this.logAudit("key_rotation", undefined, undefined, `version=${version}`);
    if (skipped > 0) {
      this.logAudit("key_rotation_skipped", undefined, undefined, `count=${skipped}`);
    }
    return { version, reencrypted, skipped };
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
    // Zero the master key in memory — prevent heap dump exposure
    zeroBuffer(this.masterKey);
  }
}
