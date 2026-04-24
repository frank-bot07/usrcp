import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type {
  GlobalPreferences,
  TamperTracker,
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
  zeroBuffer,
  safeWriteFile,
  getUserDir,
} from "../encryption.js";
import { ensurePrivateKeyEncrypted, getIdentity as getIdent, initializeIdentity as initIdent } from "../crypto.js";
import { getDefaultDbPath, generateULID } from "./helpers.js";

export class Ledger {
  /** @internal */ db: Database.Database;
  /** @internal */ closed = false;
  /** @internal */ masterKey: Buffer;

  // Static constants used across concern files
  /** @internal */ static readonly MAX_TAMPER_AUDIT_LOGS = 10;
  /** @internal */ static readonly MAX_FACT_NAMESPACE = 100;
  /** @internal */ static readonly MAX_FACT_KEY = 200;
  /** @internal */ static readonly MAX_FACT_VALUE_BYTES = 65536;

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

  /** @internal */
  encryptForDomain(plaintext: string, domain: string): string {
    const key = deriveDomainEncryptionKey(this.masterKey, domain);
    return encrypt(plaintext, key);
  }

  /** @internal */
  decryptForDomain(ciphertext: string, domain: string): string {
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
   * @internal
   */
  decryptForDomainSafe(ciphertext: string, domain: string, fallback: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext; // Legacy plaintext
    try {
      const key = deriveDomainEncryptionKey(this.masterKey, domain);
      return decrypt(ciphertext, key);
    } catch {
      return fallback;
    }
  }

  /** @internal */
  encryptGlobal(plaintext: string): string {
    const key = deriveGlobalEncryptionKey(this.masterKey);
    return encrypt(plaintext, key);
  }

  /** @internal */
  decryptGlobal(ciphertext: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext;
    const key = deriveGlobalEncryptionKey(this.masterKey);
    return decrypt(ciphertext, key);
    // GCM auth failure THROWS — tampered data must not be silently accepted.
  }

  /** @internal */
  decryptGlobalSafe(ciphertext: string, fallback: string): string {
    if (!isEncrypted(ciphertext)) return ciphertext;
    try {
      const key = deriveGlobalEncryptionKey(this.masterKey);
      return decrypt(ciphertext, key);
    } catch {
      return fallback;
    }
  }

  /** @internal */
  getTamperTracker(): TamperTracker {
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

  /** @internal */
  updateTamperTracker(updates: Partial<Omit<TamperTracker, 'sessionId'>>): void {
    const prefs = this.getPreferences();
    const tracker = this.getTamperTracker();
    const newTracker = { ...tracker, ...updates };
    this.updatePreferences({ custom: { tamperTracker: newTracker } });
  }

  /** @internal */
  handleTamper(scope: string, field: string): void {
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

  /** @internal */
  safeDecryptGlobal(ciphertext: string, fallback: string, field: string): {value: string, tampered: boolean} {
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

  /** @internal */
  safeDecryptForDomain(ciphertext: string, domain: string, fallback: string, field: string): {value: string, tampered: boolean} {
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

  /** @internal */
  getBlindTokens(text: string, domain: string): string[] {
    const key = deriveBlindIndexKey(this.masterKey, domain);
    return generateBlindTokens(text, key);
  }

  /** @internal */
  getSearchTokens(query: string, domain: string): string[] {
    const key = deriveBlindIndexKey(this.masterKey, domain);
    return generateSearchTokens(query, key);
  }

  /**
   * Generate a deterministic pseudonym for a domain name.
   * HMAC ensures same domain always maps to same pseudonym,
   * but the real domain name is not exposed in the database.
   * @internal
   */
  domainPseudonym(domain: string): string {
    const hmac = crypto.createHmac("sha256", this.masterKey);
    hmac.update(`usrcp-domain-pseudo:${domain}`);
    return "d_" + hmac.digest("hex").slice(0, 12);
  }

  /**
   * Resolve a domain pseudonym back to the real domain name.
   * Uses a lookup table stored encrypted in the database.
   * @internal
   */
  resolveDomain(pseudonym: string): string {
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
   * @internal
   */
  channelIdHash(channelId: string): string {
    return crypto
      .createHmac("sha256", this.masterKey)
      .update(`usrcp-channel-id:${channelId}`)
      .digest("hex");
  }

  /**
   * Ensure a domain mapping exists.
   * @internal
   */
  ensureDomainMapping(domain: string): string {
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

  /** @internal */
  checkExpectedVersion(
    scope: string,
    currentVersion: number,
    expectedVersion: number | undefined,
    target?: string
  ): void {
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflictError(scope, currentVersion, expectedVersion, target);
    }
  }

  /** @internal */
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

  // --------------------------------------------------------------------------
  // Stub declarations for methods implemented in concern files.
  // These are declared here (with placeholder bodies) so that:
  //   (a) core.ts compiles as a standalone module
  //   (b) the constructor can call them (they are overwritten on the prototype
  //       by each concern file's side-effect import)
  //
  // IMPORTANT: Each stub is declared as a regular method (not an arrow
  // function / instance property) so that prototype assignment in concern
  // files properly overrides it.
  // --------------------------------------------------------------------------

  /** @internal — real implementation in audit.ts */
  logAudit(
    _operation: string,
    _scopesOrDomain?: string | string[],
    _eventIds?: string[],
    _detail?: string,
    _responseSize?: number,
    _agentId?: string
  ): void {
    throw new Error("[usrcp] audit module not loaded — import ledger/index.js, not ledger/core.js");
  }

  /** @internal — real implementation in keys.ts */
  rebuildBlindIndex(): void {
    throw new Error("[usrcp] keys module not loaded — import ledger/index.js, not ledger/core.js");
  }

  /** — real implementation in identity.ts */
  getPreferences(): GlobalPreferences & {tampered?: boolean; version: number} {
    throw new Error("[usrcp] identity module not loaded — import ledger/index.js, not ledger/core.js");
  }

  /** — real implementation in identity.ts */
  updatePreferences(_prefs: Partial<GlobalPreferences>, _expectedVersion?: number): number {
    throw new Error("[usrcp] identity module not loaded — import ledger/index.js, not ledger/core.js");
  }
}
