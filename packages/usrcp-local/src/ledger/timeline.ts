import { Ledger } from "./core.js";
import type { TimelineEvent } from "../types.js";
import { safeJsonParse } from "./helpers.js";

declare module "./core.js" {
  interface Ledger {
    rowToEvent(row: any): TimelineEvent & { tampered?: boolean };
    getTimeline(options?: { last_n?: number; since?: string; domains?: string[] }): TimelineEvent[];
    searchTimeline(query: string, options?: { limit?: number; domain?: string }): TimelineEvent[];
    getRecentEventsByChannel(channelId: string, limit?: number): TimelineEvent[];
  }
}

/**
 * Convert a database row to a TimelineEvent.
 * GCM failures are caught PER FIELD — a tampered field does not crash the
 * entire read. Tampered fields are replaced with "[TAMPERED]" and the event
 * is flagged. This is the correct middle ground between silent suppression
 * (old behavior) and hard crash (previous fix).
 */
Ledger.prototype.rowToEvent = function (
  this: Ledger,
  row: any
): TimelineEvent & { tampered?: boolean } {
  const domainPseudo = row.domain;
  const domain = this.resolveDomain(domainPseudo);

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
};

Ledger.prototype.getTimeline = function (
  this: Ledger,
  options?: { last_n?: number; since?: string; domains?: string[] }
): TimelineEvent[] {
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
};

Ledger.prototype.searchTimeline = function (
  this: Ledger,
  query: string,
  options?: { limit?: number; domain?: string }
): TimelineEvent[] {
  const limit = options?.limit || 20;

  // Determine which domains to search (using real domain names for key derivation)
  const realDomains = options?.domain
    ? [options.domain]
    : getAllRealDomains(this);

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

  // Fetch the actual events. Chunk to SQLite's parameter limit
  // (SQLITE_MAX_VARIABLE_NUMBER defaults to 999) to avoid
  // "too many SQL variables" when the match set is large.
  const ids = [...matchingEventIds];
  const CHUNK_SIZE = 999;
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const chunkRows = this.db
      .prepare(
        `SELECT * FROM timeline_events
        WHERE event_id IN (${placeholders})`
      )
      .all(...chunk) as any[];
    rows.push(...chunkRows);
  }

  // Sort and limit in memory since we chunked the SELECT.
  rows.sort((a, b) => b.ledger_sequence - a.ledger_sequence);
  const limitedRows = rows.slice(0, limit);

  const results = limitedRows.map((r) => this.rowToEvent(r));
  this.logAudit("search_timeline", undefined, results.map((e) => e.event_id), `query_length=${query.length}`);
  return results;
};

Ledger.prototype.getRecentEventsByChannel = function (
  this: Ledger,
  channelId: string,
  limit: number = 10
): TimelineEvent[] {
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
};

/** @internal */
function getAllRealDomains(ledger: Ledger): string[] {
  const rows = ledger.db
    .prepare("SELECT pseudonym, encrypted_name FROM domain_map")
    .all() as any[];
  return rows.map((r: any) => ledger.decryptGlobal(r.encrypted_name)).filter(Boolean);
}
