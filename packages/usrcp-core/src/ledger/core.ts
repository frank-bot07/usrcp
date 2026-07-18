import Database from "./sqlite.js";
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
  hashProjectId,
  hashIdempotencyKey,
  encrypt,
  decrypt,
  isEncrypted,
  generateBlindTokens,
  generateSearchTokens,
  zeroBuffer,
  safeWriteFile,
  getUserDir,
  commitKeyRotation,
  deserializePendingKeyFiles,
} from "../encryption.js";
import { ensurePrivateKeyEncrypted, getIdentity as getIdent, initializeIdentity as initIdent } from "../crypto.js";
import { getDefaultDbPath, generateULID } from "./helpers.js";

/**
 * Adapter-rotation recovery hook. The low-level ledger must not depend on the
 * adapter system (registry, per-adapter config encryption) — that lives in the
 * server/CLI layer (`usrcp-local`). Instead, the ledger exposes this seam and
 * the adapter-aware layer registers `resumeAdapterRotationIfPending` into it.
 *
 * Behavior parity: when no hook is registered (e.g. core's own tests, or a
 * pure-protocol consumer with no adapters) the recovery step is a no-op, exactly
 * as it was when no rotation checkpoint existed. `usrcp-local` registers the hook
 * as a side effect of its `ledger` barrel, so every adapter-aware consumer keeps
 * recovery-on-open identical to the pre-split behavior.
 */
export interface AdapterRotationResumeResult {
  rotated: unknown[];
  absent: unknown[];
  failed: unknown[];
}
export type AdapterRotationResumeHook = (opts: {
  userDir: string;
  currentMasterKey: Buffer;
}) => AdapterRotationResumeResult | null;

let adapterRotationResumeHook: AdapterRotationResumeHook | null = null;

/** Register (or clear, with `null`) the adapter-rotation recovery hook. */
export function setAdapterRotationResumeHook(
  hook: AdapterRotationResumeHook | null,
): void {
  adapterRotationResumeHook = hook;
}

export class Ledger {
  /** @internal */ db: Database;
  /** @internal */ closed = false;
  /** @internal */ masterKey: Buffer;
  /**
   * Re-entrancy guard for handleTamper. The tamper-tracker read/write
   * routes through getPreferences()/updatePreferences(), which decrypt the
   * same global blob that may itself be damaged — so a damaged prefs blob
   * would recurse infinitely without this. See handleTamper.
   * @internal
   */
  private _handlingTamper = false;

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
    // Migrate FIRST so rotation_state.pending_files_json (PR #72)
    // exists for the pre-init recovery probe below. migrate() only
    // touches DB schema; it does not reference masterKey or read
    // any key files, so it is safe to call before
    // initializeMasterKey.
    this.migrate();

    // Pre-init rotation recovery (Codex round-1 P1 on PR #72): if a
    // previous rotateKey committed the DB transaction (rows
    // re-encrypted under the new master key; rotation_state.
    // pending_files_json set) but died before commitKeyRotation wrote
    // the new key-file set, the canonical master.salt / master.verify
    // still derive the OLD key. initializeMasterKey with the user's
    // NEW passphrase would throw "Invalid passphrase" against the
    // stale verify hash, locking the user out even though the
    // recovery material is durably in rotation_state.
    //
    // Resolution: replay the pending key-file set BEFORE
    // initializeMasterKey runs, so initializeMasterKey reads the
    // post-rotation canonical files and re-derives the correct new key
    // from the user's NEW passphrase. The post-init durable-replay
    // branch below then just clears the checkpoint + rebuilds the blind
    // index — since M2 there is no raw key to install (only the legacy
    // pre-#72 branch still installs a key from pending_key).
    const rotationRow = this.db.prepare(
      "SELECT pending_key, pending_version, pending_files_json FROM rotation_state WHERE id = 1"
    ).get() as any;
    let durableReplay = false;
    // Trigger on pending_files_json alone. Since M2, rotations no longer
    // persist the raw key in pending_key, so a mid-rotation crash leaves
    // only pending_files_json — the durable, non-secret recovery material.
    if (rotationRow?.pending_files_json) {
      try {
        const pending = deserializePendingKeyFiles(rotationRow.pending_files_json);
        // Guard against a corrupt / hand-edited "[]" checkpoint: an empty set
        // replays nothing, so treating it as a successful recovery would clear
        // the checkpoint while the DB is under the new key and the files under
        // the old key. A real rotateKey always writes a non-empty set.
        if (pending.length === 0) {
          throw new Error("empty pending_files_json — not a valid rotation checkpoint");
        }
        commitKeyRotation(pending);
        durableReplay = true;
      } catch (err) {
        // Leave rotation_state intact (not cleared) so the next open
        // retries the replay. In passphrase mode initializeMasterKey below
        // will then throw "Invalid passphrase" (canonical files still
        // derive the old key), surfacing the interrupted state rather than
        // silently opening under a stale key.
        console.warn(
          `[usrcp] pre-init rotation replay failed: ${
            err instanceof Error ? err.message : String(err)
          }. Rotation checkpoint left in place; retry on next open.`
        );
      }
    }

    this.masterKey = initializeMasterKey(passphrase);
    // Initialize identity if needed (requires master key for private key encryption)
    if (!getIdent()) {
      initIdent(this.masterKey);
    }
    // Encrypt legacy plaintext private keys
    ensurePrivateKeyEncrypted(this.masterKey);

    // Post-init rotation recovery.
    if (durableReplay) {
      // Durable replay (above) wrote the new canonical key files BEFORE
      // initializeMasterKey ran, so this.masterKey was just derived as the
      // correct NEW key — from the new passphrase + replayed
      // master.salt/verify, or the replayed dev master.key. Nothing more to
      // install; the raw key was never persisted (M2). Clear the checkpoint
      // and rebuild the blind index under the new key.
      this.db.prepare(
        "UPDATE rotation_state SET pending_key = NULL, pending_version = NULL, pending_files_json = NULL WHERE id = 1"
      ).run();
      this.logAudit(
        "key_rotation_recovery",
        ["system"],
        undefined,
        "mode=durable-replay"
      );
      this.rebuildBlindIndex();
    } else if (rotationRow?.pending_key) {
      // Legacy fallback: a pre-PR#72 crash left a raw pending_key with no
      // pending_files_json (so durableReplay never fired). Since M2, new
      // rotations never write pending_key, so this only ever runs for an old
      // DB. Install the recovered key and persist it as master.key —
      // dev-mode-only in practice, since a passphrase-mode legacy row would
      // have thrown "Invalid passphrase" in initializeMasterKey above.
      const oldKey = this.masterKey;
      this.masterKey = Buffer.from(rotationRow.pending_key);
      // Zero the old key buffer — prevent heap residue
      zeroBuffer(oldKey);
      const keysDir = path.join(getUserDir(), "keys");
      fs.mkdirSync(keysDir, { recursive: true });
      safeWriteFile(path.join(keysDir, "master.key"), this.masterKey, 0o600);
      this.db.prepare(
        "UPDATE rotation_state SET pending_key = NULL, pending_version = NULL, pending_files_json = NULL WHERE id = 1"
      ).run();
      this.logAudit(
        "key_rotation_recovery",
        ["system"],
        undefined,
        "mode=legacy-master-key-only"
      );
      this.rebuildBlindIndex();
    }
    // else: no checkpoint, or a pending_files_json replay failed above (the
    // row is left intact so the next open retries) — nothing to clear here.

    // Data migrations that need this.masterKey (e.g. blind-index
    // rebuild for older DBs that have events but no blind_index
    // rows). Split out of migrate() in PR #72 because migrate() now
    // runs BEFORE initializeMasterKey to make rotation_state.
    // pending_files_json available for the pre-init recovery
    // replay. (Codex round-2 P1.)
    this.migrateData();

    // Adapter-config rotation recovery: if a previous rotateKey was
    // killed AFTER commitKeyRotation but BEFORE all adapter configs
    // were re-encrypted, the checkpoint at <userDir>/keys/adapter-rotation.json
    // persists with the old key sealed under the new global key. Resume
    // the per-adapter loop for whatever's still `pending`. Without this,
    // those configs would be permanently unreadable: the old salt is
    // gone, so the old master key is no longer derivable from passphrase.
    try {
      const resumed = adapterRotationResumeHook?.({
        userDir: getUserDir(),
        currentMasterKey: this.masterKey,
      }) ?? null;
      if (resumed) {
        this.logAudit(
          "adapter_rotation_recovery",
          ["system"],
          undefined,
          `rotated=${resumed.rotated.length} absent=${resumed.absent.length} failed=${resumed.failed.length}`
        );
      }
    } catch (err) {
      // Recovery is best-effort: a malformed checkpoint should not
      // block the Ledger from opening. The original rotation's audit
      // log entry stays as the durable record; surface the recovery
      // hiccup to console for operator inspection.
      console.warn(
        `[usrcp] adapter rotation recovery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Returns the in-memory master key. Used by sibling packages (e.g.
   * `usrcp-stream`) that share the same passphrase + keyspace and need to
   * derive their own per-domain keys via `deriveDomainEncryptionKey`. The
   * returned Buffer is the live key; callers must not mutate it.
   */
  getMasterKey(): Buffer {
    return this.masterKey;
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
    // Re-entrancy guard. getTamperTracker() and updateTamperTracker() below
    // both call getPreferences(), which decrypts the global_preferences
    // `custom` blob — the very blob that, when damaged, routed us here via
    // safeDecryptGlobal → handleTamper. Without this guard a damaged custom
    // blob recurses (getPreferences → safeDecryptGlobal fails → handleTamper
    // → getTamperTracker → getPreferences → ...) and blows the stack before
    // the count-based hard stop below can fire. Swallowing the re-entrant
    // call lets the OUTER handleTamper complete its single increment using
    // the fallback ("{}") prefs, and lets repeated distinct tamper events
    // accumulate toward the >= 50 hard stop, which surfaces as a clean
    // structured error instead of a RangeError. (v0.1.7)
    if (this._handlingTamper) return;
    this._handlingTamper = true;
    try {
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
    } finally {
      this._handlingTamper = false;
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
    // Use silent-safe decrypt (not the audit-logging safeDecryptGlobal):
    // resolveDomain is called once per timeline row in rowToEvent, so the
    // audit-logging variant would flood the tamper tracker on legitimate
    // rotation-skipped domain_map entries. Per-event tampered flags are
    // already tracked at field granularity inside rowToEvent.
    return this.decryptGlobalSafe(row.encrypted_name, pseudonym) || pseudonym;
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

    // v0.2.3 migration: opaque idempotency_key. The caller-supplied dedup key
    // was the last unencrypted caller-authored column — stored verbatim here
    // AND pushed to the sync relay in cleartext. Store HMAC(key) in
    // idempotency_hash instead (same leak class the project_id HMAC closed).
    // The re-key of existing rows + erasure of the plaintext happens in
    // migrateData() (needs the master key).
    try {
      this.db.exec("ALTER TABLE timeline_events ADD COLUMN idempotency_hash TEXT");
    } catch {
      // Column already exists
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency_hash ON timeline_events(idempotency_hash) WHERE idempotency_hash IS NOT NULL"
    );

    // v0.1.3 migration: add integrity_tag to audit_log
    try {
      this.db.exec("ALTER TABLE audit_log ADD COLUMN integrity_tag TEXT");
    } catch {
      // Column already exists
    }

    // v0.2.2 migration: opaque project_id. Adds project_ref_enc; the row
    // re-key of existing plaintext ids happens in migrateData() (needs the
    // master key).
    try {
      this.db.exec("ALTER TABLE active_projects ADD COLUMN project_ref_enc TEXT");
    } catch {
      // Column already exists
    }

    // PR #72 migration: add pending_files_json to rotation_state so
    // recovery can replay the FULL target key-file set (master.salt,
    // master.verify, mode, key.version, etc.) rather than only
    // writing master.key. Without this column, a passphrase-mode
    // rotation that committed the DB transaction but died before
    // commitKeyRotation would brick the user: the DB is re-encrypted
    // under the new key, but the canonical master.salt/verify still
    // derive the OLD key. Codex round-1 P1 on PR #72.
    try {
      this.db.exec("ALTER TABLE rotation_state ADD COLUMN pending_files_json TEXT");
    } catch {
      // Column already exists
    }

    // v0.1.5: track last successful rotation so rotateKey can rate-limit
    // reflexive agent calls. Without this, an agent on a tool-call loop can
    // burn through hundreds of rotations and silently lose any row that
    // ever fails to MAC-verify (skip-damaged-rows behavior in rotateKey
    // is per-rotation, but key history is not preserved, so a row that
    // fails once is gone forever).
    try {
      this.db.exec("ALTER TABLE rotation_state ADD COLUMN last_rotation_at TEXT");
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

    // v0.2.2 migration: version column on domain_map for sync conflict resolution
    try {
      this.db.exec("ALTER TABLE domain_map ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists
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
  }

  /**
   * Data migrations that REQUIRE this.masterKey. Split out of
   * migrate() in PR #72 so schema-only setup can run before
   * initializeMasterKey (the pre-init rotation-recovery replay
   * depends on rotation_state.pending_files_json existing).
   * Codex round-2 P1: rebuildBlindIndex() decrypts event fields and
   * derives blind-index keys from this.masterKey, so calling it
   * from inside migrate() before initializeMasterKey assigned
   * this.masterKey would crash or produce bad crypto state. This
   * method runs AFTER initializeMasterKey + the post-init recovery
   * block.
   */
  private migrateData(): void {
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

    // v0.2.2: opaque project_id. Legacy rows stored the caller's id in
    // cleartext (project_ref_enc IS NULL). Re-key each to HMAC(id) and stash
    // the original id encrypted in project_ref_enc. Idempotent — migrated rows
    // have a non-null project_ref_enc and are skipped on the next open.
    const legacyProjects = this.db
      .prepare("SELECT project_id FROM active_projects WHERE project_ref_enc IS NULL")
      .all() as { project_id: string }[];
    if (legacyProjects.length > 0) {
      const upd = this.db.prepare(
        "UPDATE active_projects SET project_id = ?, project_ref_enc = ? WHERE project_id = ?"
      );
      this.db.transaction(() => {
        for (const row of legacyProjects) {
          upd.run(
            hashProjectId(this.masterKey, row.project_id),
            this.encryptGlobal(row.project_id),
            row.project_id
          );
        }
      })();
    }

    // v0.2.3: opaque idempotency_key. Legacy rows stored the caller's dedup
    // key in cleartext. Re-key each to HMAC in idempotency_hash and ERASE the
    // plaintext. Idempotent — migrated rows have idempotency_key NULL, so the
    // WHERE clause skips them on the next open.
    const legacyIdem = this.db
      .prepare(
        "SELECT event_id, idempotency_key FROM timeline_events WHERE idempotency_key IS NOT NULL"
      )
      .all() as { event_id: string; idempotency_key: string }[];
    if (legacyIdem.length > 0) {
      const updIdem = this.db.prepare(
        "UPDATE timeline_events SET idempotency_hash = ?, idempotency_key = NULL WHERE event_id = ?"
      );
      this.db.transaction(() => {
        for (const row of legacyIdem) {
          updIdem.run(
            hashIdempotencyKey(this.masterKey, row.idempotency_key),
            row.event_id
          );
        }
      })();
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
  //
  // These stubs exist so that:
  //   (a) core.ts compiles as a standalone module — its own methods
  //       (constructor, migrate, getTamperTracker) call logAudit,
  //       rebuildBlindIndex, getPreferences, updatePreferences directly.
  //   (b) If someone imports directly from ledger/core.js instead of the
  //       barrel (ledger/index.js), they get a loud runtime error instead
  //       of a silently undefined method.
  //
  // At module load, each concern file's side-effect import does
  //   Ledger.prototype.logAudit = function(...) { ... }
  // which overwrites these stubs with the real implementations. This
  // prototype augmentation is idempotent — re-importing the barrel does
  // not reset them.
  //
  // ⚠️  SIGNATURE DRIFT RISK:
  // Each stub signature is duplicated by a `declare module "./core.js"`
  // block in the corresponding concern file (audit.ts, keys.ts,
  // identity.ts). TypeScript's declaration merging means the concern
  // file's signature wins for callers — TS will NOT report a mismatch
  // if the stub here drifts from the concern file's declaration. When
  // you change a signature, you MUST update both locations.
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
