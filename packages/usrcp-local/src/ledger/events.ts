import { Ledger } from "./core.js";
import type { AppendEventInput } from "../types.js";
import { generateULID } from "./helpers.js";

declare module "./core.js" {
  interface Ledger {
    appendEvent(
      event: AppendEventInput,
      platform: string,
      idempotencyKey?: string,
      agentId?: string
    ): { event_id: string; timestamp: string; ledger_sequence: number; duplicate?: boolean };
    pruneOldEvents(daysOld?: number): { pruned: number; compacted: number };
    deleteOldEvents(daysOld: number): number;
    secureWipe(): void;
    listEncryptedEventsAbove(minSeq: number, limit?: number): Array<{
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
    }>;
    getMaxSequence(): number;
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
    }>): number;
    getStats(): {
      total_events: number;
      total_projects: number;
      domains: string[];
      platforms: string[];
      db_size_bytes: number;
      audit_log_entries: number;
      encryption_enabled: boolean;
    };
  }
}

/** @internal — input validation (defense-in-depth, supplements Zod schemas) */
function validateEventInput(
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

Ledger.prototype.appendEvent = function (
  this: Ledger,
  event: AppendEventInput,
  platform: string,
  idempotencyKey?: string,
  agentId: string = "system"
): { event_id: string; timestamp: string; ledger_sequence: number; duplicate?: boolean } {
  validateEventInput(event, platform, idempotencyKey);

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
};

/**
 * Prune old events: events older than `daysOld` are deleted.
 * Detail and artifact data is stripped — only summary/intent/outcome remain
 * in a compacted "pruned" marker event.
 * Returns the number of events pruned.
 */
Ledger.prototype.pruneOldEvents = function (
  this: Ledger,
  daysOld: number = 30
): { pruned: number; compacted: number } {
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
};

/**
 * Delete events older than `daysOld` entirely.
 * Use with caution — this permanently removes history.
 */
Ledger.prototype.deleteOldEvents = function (
  this: Ledger,
  daysOld: number
): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  const cutoffIso = cutoff.toISOString();

  // Get event IDs to delete (for blind index cleanup)
  const toDelete = this.db
    .prepare("SELECT event_id FROM timeline_events WHERE timestamp < ?")
    .all(cutoffIso) as any[];
  const eventIds = toDelete.map((r: any) => r.event_id);

  if (eventIds.length === 0) return 0;

  // Chunk to SQLite's parameter limit (SQLITE_MAX_VARIABLE_NUMBER
  // defaults to 999) so a large prune doesn't blow up on "too many
  // SQL variables".
  const CHUNK_SIZE = 999;
  for (let i = 0; i < eventIds.length; i += CHUNK_SIZE) {
    const chunk = eventIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM blind_index WHERE event_id IN (${placeholders})`)
      .run(...chunk);
  }

  // Delete events (secure_delete pragma ensures zero-fill)
  const result = this.db
    .prepare("DELETE FROM timeline_events WHERE timestamp < ?")
    .run(cutoffIso);

  this.logAudit("delete_old_events", undefined, eventIds);
  return result.changes;
};

/**
 * Secure wipe: VACUUM after delete to reclaim and zero-fill pages.
 * Call after deleteOldEvents() for forensic-grade deletion.
 */
Ledger.prototype.secureWipe = function (this: Ledger): void {
  this.db.pragma("wal_checkpoint(TRUNCATE)");
  this.db.exec("VACUUM");
  this.logAudit("secure_wipe");
};

/**
 * Return raw encrypted event rows with ledger_sequence > minSeq. The
 * sync client forwards these verbatim to the hosted ledger — none of
 * the encrypted columns are decrypted here.
 */
Ledger.prototype.listEncryptedEventsAbove = function (
  this: Ledger,
  minSeq: number,
  limit: number = 500
): any[] {
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
};

Ledger.prototype.getMaxSequence = function (this: Ledger): number {
  const row = this.db
    .prepare("SELECT COALESCE(MAX(ledger_sequence), 0) AS max_seq FROM timeline_events")
    .get() as { max_seq: number };
  return Number(row.max_seq ?? 0);
};

/**
 * Insert events pulled from the hosted ledger. Each event is assigned
 * the next local sequence. Events already present by event_id are
 * skipped. Blind-index tokens are NOT populated — pulled events are
 * searchable only after the next full rebuild (next ledger open).
 * Returns the number of events actually inserted.
 */
Ledger.prototype.applyPulledEvents = function (
  this: Ledger,
  events: Array<{
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
  }>
): number {
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
};

Ledger.prototype.getStats = function (this: Ledger): {
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
};
