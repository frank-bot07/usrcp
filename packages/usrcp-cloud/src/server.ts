/**
 * Fastify server exposing the three USRCP sync endpoints.
 *
 * CRITICAL: the server never sees plaintext. Every encrypted field from
 * the client is stored verbatim as an opaque string. If you find
 * yourself decrypting, you've broken the model.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { verifyAndClaim, AuthError } from "./auth.js";

// --- Wire schemas (Zod) ---

const EventSchema = z.object({
  event_id: z.string().min(1).max(64),
  client_timestamp: z.string().min(1).max(40),
  ledger_sequence: z.number().int().min(1).optional(),
  domain_pseudonym: z.string().min(3).max(64),
  platform_enc: z.string().max(8192).nullable().optional(),
  summary_enc: z.string().min(1).max(8192),
  intent_enc: z.string().max(8192).nullable().optional(),
  outcome_enc: z.string().max(8192).nullable().optional(),
  detail_enc: z.string().max(131072).nullable().optional(), // 128 KiB
  artifacts_enc: z.string().max(65536).nullable().optional(),
  tags_enc: z.string().max(16384).nullable().optional(),
  session_id_enc: z.string().max(8192).nullable().optional(),
  parent_event_id_enc: z.string().max(8192).nullable().optional(),
  idempotency_key: z.string().min(1).max(100).nullable().optional(),
});

const AppendEventsBody = z.object({
  events: z.array(EventSchema).min(1).max(500),
});

const IdentityUpdate = z.object({
  display_name_enc: z.string().max(8192).optional(),
  roles_enc: z.string().max(16384).optional(),
  expertise_domains_enc: z.string().max(16384).optional(),
  communication_style_enc: z.string().max(2048).optional(),
  version: z.number().int().min(1).optional(),
  expected_version: z.number().int().min(0).optional(),
});

const PreferencesUpdate = z.object({
  language_enc: z.string().max(2048).optional(),
  timezone_enc: z.string().max(2048).optional(),
  output_format_enc: z.string().max(2048).optional(),
  verbosity_enc: z.string().max(2048).optional(),
  custom_enc: z.string().max(65536).optional(),
  version: z.number().int().min(1).optional(),
  expected_version: z.number().int().min(0).optional(),
});

const DomainContextUpdate = z.object({
  domain_pseudonym: z.string().min(3).max(64),
  context_enc: z.string().min(1).max(131072),
  version: z.number().int().min(1).optional(),
  expected_version: z.number().int().min(0).optional(),
});

const FactUpdate = z.object({
  fact_id: z.string().min(1).max(64),
  domain_pseudonym: z.string().min(3).max(64),
  ns_key_hash: z.string().min(16).max(128),
  namespace_enc: z.string().min(1).max(8192),
  key_enc: z.string().min(1).max(8192),
  value_enc: z.string().min(1).max(131072),
  version: z.number().int().min(1).optional(),
  expected_version: z.number().int().min(0).optional(),
});

const ProjectUpdate = z.object({
  project_id: z.string().min(1).max(100),
  name_enc: z.string().min(1).max(8192),
  domain_enc: z.string().min(1).max(8192),
  status_enc: z.string().min(1).max(2048),
  summary_enc: z.string().max(8192),
});

const UpdateStateBody = z.object({
  identity: IdentityUpdate.optional(),
  preferences: PreferencesUpdate.optional(),
  domain_contexts: z.array(DomainContextUpdate).max(50).optional(),
  facts: z.array(FactUpdate).max(500).optional(),
  projects: z.array(ProjectUpdate).max(500).optional(),
});

// --- Factory ---

export interface ServerOptions {
  db: Db;
  logger?: boolean;
}

// Max request body size. MCP payloads are JSON (ciphertext blobs); 2 MiB
// leaves headroom for the largest legitimate payload (500 events × ~4 KiB
// summary ciphertext each) without allowing DoS-sized uploads.
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export function createApp(opts: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: MAX_REQUEST_BODY_BYTES,
  });
  const db = opts.db;

  // Read the raw body so we can hash it for signature verification.
  // Fastify parses JSON by default; we also capture the raw bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const json = body.length === 0 ? {} : JSON.parse(body as string);
        done(null, json);
      } catch (err) {
        done(err as Error);
      }
    }
  );

  // Capture the raw body string so the auth verifier can hash it.
  // Enforces MAX_REQUEST_BODY_BYTES inside the streaming loop so a
  // malicious client cannot OOM the process before Fastify's bodyLimit
  // would otherwise kick in.
  app.addHook("preParsing", async (req, reply, payload) => {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        reply.code(413).send({ error: "PAYLOAD_TOO_LARGE", max_bytes: MAX_REQUEST_BODY_BYTES });
        return;
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    (req as any).rawBody = raw;
    const { Readable } = await import("node:stream");
    return Readable.from([raw]);
  });

  // --- GET /healthz — unauthenticated ---
  app.get("/healthz", async () => ({ status: "ok" }));

  // --- GET /v1/state ---
  app.get("/v1/state", async (req, reply) => {
    const auth = await tryAuth(req, reply, db, "");
    if (!auth) return;
    const since = numberQuery(req.query as any, "since") ?? 0;
    const limit = Math.min(numberQuery(req.query as any, "limit") ?? 500, 500);

    const [events, identity, preferences, domainContexts, projects, facts] = await Promise.all([
      db.query(
        `SELECT event_id, ledger_sequence, client_timestamp, server_timestamp,
                domain_pseudonym, platform_enc, summary_enc, intent_enc, outcome_enc,
                detail_enc, artifacts_enc, tags_enc, session_id_enc, parent_event_id_enc
         FROM timeline_events
         WHERE user_public_key = $1 AND ledger_sequence > $2
         ORDER BY ledger_sequence ASC LIMIT $3`,
        [auth.userPublicKey, since, limit]
      ),
      db.query(
        "SELECT * FROM core_identity WHERE user_public_key = $1",
        [auth.userPublicKey]
      ),
      db.query(
        "SELECT * FROM global_preferences WHERE user_public_key = $1",
        [auth.userPublicKey]
      ),
      db.query(
        `SELECT domain_pseudonym, context_enc, version, updated_at
         FROM domain_context WHERE user_public_key = $1`,
        [auth.userPublicKey]
      ),
      db.query(
        `SELECT project_id, name_enc, domain_enc, status_enc, summary_enc, last_touched
         FROM active_projects WHERE user_public_key = $1`,
        [auth.userPublicKey]
      ),
      db.query(
        `SELECT fact_id, domain_pseudonym, ns_key_hash, namespace_enc, key_enc,
                value_enc, version, updated_at
         FROM schemaless_facts WHERE user_public_key = $1`,
        [auth.userPublicKey]
      ),
    ]);

    // Cursor = highest sequence in the returned page. If the page is full,
    // more events exist past this cursor — client re-requests with since=cursor.
    // An empty page means the client is caught up at `since`.
    const cursor = events.rows.length > 0
      ? Number(events.rows[events.rows.length - 1].ledger_sequence)
      : since;

    return {
      events: events.rows,
      identity: identity.rows[0] ?? null,
      preferences: preferences.rows[0] ?? null,
      domain_contexts: domainContexts.rows,
      projects: projects.rows,
      facts: facts.rows,
      cursor,
      has_more: events.rows.length === limit,
    };
  });

  // --- POST /v1/events ---
  app.post("/v1/events", async (req, reply) => {
    const raw = (req as any).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;

    const parse = AppendEventsBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "BAD_BODY", issues: parse.error.issues });
    }

    return pushWithRetry(db, auth.userPublicKey, parse.data.events);
  });

  // --- POST /v1/state ---
  app.post("/v1/state", async (req, reply) => {
    const raw = (req as any).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;

    const parse = UpdateStateBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "BAD_BODY", issues: parse.error.issues });
    }
    const body = parse.data;

    // Identity — upsert, check expected_version if given
    if (body.identity) {
      const cur = await db.query(
        "SELECT version FROM core_identity WHERE user_public_key = $1",
        [auth.userPublicKey]
      );
      const currentVersion = Number(cur.rows[0]?.version ?? 0);
      if (replyVersionConflictIfMismatch(reply, "core_identity", currentVersion, body.identity.expected_version)) return;
      const newVersion = currentVersion + 1;
      await db.query(
        `INSERT INTO core_identity
           (user_public_key, display_name_enc, roles_enc, expertise_domains_enc, communication_style_enc, version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_public_key) DO UPDATE SET
           display_name_enc = COALESCE(EXCLUDED.display_name_enc, core_identity.display_name_enc),
           roles_enc = COALESCE(EXCLUDED.roles_enc, core_identity.roles_enc),
           expertise_domains_enc = COALESCE(EXCLUDED.expertise_domains_enc, core_identity.expertise_domains_enc),
           communication_style_enc = COALESCE(EXCLUDED.communication_style_enc, core_identity.communication_style_enc),
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          auth.userPublicKey,
          body.identity.display_name_enc ?? "",
          body.identity.roles_enc ?? "",
          body.identity.expertise_domains_enc ?? "",
          body.identity.communication_style_enc ?? "",
          newVersion,
        ]
      );
    }

    // Preferences — upsert, check expected_version
    if (body.preferences) {
      const cur = await db.query(
        "SELECT version FROM global_preferences WHERE user_public_key = $1",
        [auth.userPublicKey]
      );
      const currentVersion = Number(cur.rows[0]?.version ?? 0);
      if (replyVersionConflictIfMismatch(reply, "global_preferences", currentVersion, body.preferences.expected_version)) return;
      const newVersion = currentVersion + 1;
      await db.query(
        `INSERT INTO global_preferences
           (user_public_key, language_enc, timezone_enc, output_format_enc, verbosity_enc, custom_enc, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_public_key) DO UPDATE SET
           language_enc = COALESCE(EXCLUDED.language_enc, global_preferences.language_enc),
           timezone_enc = COALESCE(EXCLUDED.timezone_enc, global_preferences.timezone_enc),
           output_format_enc = COALESCE(EXCLUDED.output_format_enc, global_preferences.output_format_enc),
           verbosity_enc = COALESCE(EXCLUDED.verbosity_enc, global_preferences.verbosity_enc),
           custom_enc = COALESCE(EXCLUDED.custom_enc, global_preferences.custom_enc),
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          auth.userPublicKey,
          body.preferences.language_enc ?? "",
          body.preferences.timezone_enc ?? "",
          body.preferences.output_format_enc ?? "",
          body.preferences.verbosity_enc ?? "",
          body.preferences.custom_enc ?? "",
          newVersion,
        ]
      );
    }

    // Domain contexts — per-row LWW with optional expected_version
    for (const ctx of body.domain_contexts ?? []) {
      const cur = await db.query(
        "SELECT version FROM domain_context WHERE user_public_key = $1 AND domain_pseudonym = $2",
        [auth.userPublicKey, ctx.domain_pseudonym]
      );
      const currentVersion = Number(cur.rows[0]?.version ?? 0);
      if (replyVersionConflictIfMismatch(reply, "domain_context", currentVersion, ctx.expected_version, ctx.domain_pseudonym)) return;
      await db.query(
        `INSERT INTO domain_context (user_public_key, domain_pseudonym, context_enc, version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_public_key, domain_pseudonym) DO UPDATE SET
           context_enc = EXCLUDED.context_enc,
           version = EXCLUDED.version,
           updated_at = now()`,
        [auth.userPublicKey, ctx.domain_pseudonym, ctx.context_enc, currentVersion + 1]
      );
    }

    // Schemaless facts — per-row LWW with optional expected_version.
    // Uniqueness is (user, domain, ns_key_hash). We branch on existence
    // rather than use ON CONFLICT because we need the pre-update version
    // for the conflict check, and composite ON CONFLICT targets behave
    // inconsistently across Postgres and in-memory test adapters.
    for (const f of body.facts ?? []) {
      const cur = await db.query<{ fact_id: string; version: number }>(
        "SELECT fact_id, version FROM schemaless_facts WHERE user_public_key = $1 AND domain_pseudonym = $2 AND ns_key_hash = $3",
        [auth.userPublicKey, f.domain_pseudonym, f.ns_key_hash]
      );
      const existing = cur.rows[0];
      const currentVersion = Number(existing?.version ?? 0);
      if (replyVersionConflictIfMismatch(reply, "schemaless_facts", currentVersion, f.expected_version, `${f.domain_pseudonym}/${f.ns_key_hash}`)) return;
      if (existing) {
        await db.query(
          `UPDATE schemaless_facts
             SET namespace_enc = $1, key_enc = $2, value_enc = $3,
                 version = $4, updated_at = now()
           WHERE user_public_key = $5 AND fact_id = $6`,
          [
            f.namespace_enc,
            f.key_enc,
            f.value_enc,
            currentVersion + 1,
            auth.userPublicKey,
            existing.fact_id,
          ]
        );
      } else {
        await db.query(
          `INSERT INTO schemaless_facts
             (user_public_key, fact_id, domain_pseudonym, ns_key_hash,
              namespace_enc, key_enc, value_enc, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [
            auth.userPublicKey,
            f.fact_id,
            f.domain_pseudonym,
            f.ns_key_hash,
            f.namespace_enc,
            f.key_enc,
            f.value_enc,
          ]
        );
      }
    }

    // Projects — simple LWW on the row (no version col in Phase 1)
    for (const p of body.projects ?? []) {
      await db.query(
        `INSERT INTO active_projects
           (user_public_key, project_id, name_enc, domain_enc, status_enc, summary_enc, last_touched)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_public_key, project_id) DO UPDATE SET
           name_enc = EXCLUDED.name_enc,
           domain_enc = EXCLUDED.domain_enc,
           status_enc = EXCLUDED.status_enc,
           summary_enc = EXCLUDED.summary_enc,
           last_touched = EXCLUDED.last_touched`,
        [auth.userPublicKey, p.project_id, p.name_enc, p.domain_enc, p.status_enc, p.summary_enc]
      );
    }

    return { status: "ok" };
  });

  return app;
}

// --- Push helpers ---

type PushedEvent = z.infer<typeof EventSchema>;

type PushResult = {
  accepted: { event_id: string; ledger_sequence: number; duplicate: boolean }[];
  cursor: number;
};

async function pushAtomic(db: Db, userPublicKey: string, events: PushedEvent[]): Promise<PushResult> {
  return db.transaction(async (client) => {
    // Lock the user row for the duration of this transaction. Any concurrent
    // push for the same user blocks here until we COMMIT, eliminating the
    // TOCTOU window between SELECT MAX(ledger_sequence) and INSERT.
    await client.query(
      "SELECT public_key FROM users WHERE public_key = $1 FOR UPDATE",
      [userPublicKey]
    );

    const maxSeqResult = await client.query<{ max_seq: string }>(
      `SELECT COALESCE(MAX(ledger_sequence), 0) AS max_seq
       FROM timeline_events WHERE user_public_key = $1`,
      [userPublicKey]
    );
    let nextSeq = Number(maxSeqResult.rows[0]?.max_seq ?? 0);

    const existingByKey = new Map<string, { event_id: string; ledger_sequence: number }>();
    const idempKeys = events.map((e) => e.idempotency_key).filter((k): k is string => !!k);
    if (idempKeys.length > 0) {
      const idempResult = await client.query<{ event_id: string; ledger_sequence: number; idempotency_key: string }>(
        `SELECT event_id, ledger_sequence, idempotency_key
         FROM timeline_events
         WHERE user_public_key = $1 AND idempotency_key = ANY($2::text[])`,
        [userPublicKey, idempKeys]
      );
      for (const row of idempResult.rows) {
        existingByKey.set(row.idempotency_key, {
          event_id: row.event_id,
          ledger_sequence: Number(row.ledger_sequence),
        });
      }
    }

    const accepted: PushResult["accepted"] = [];
    const toInsert: {
      event_id: string; ledger_sequence: number; client_timestamp: string;
      domain_pseudonym: string; platform_enc: string | null; summary_enc: string;
      intent_enc: string | null; outcome_enc: string | null; detail_enc: string | null;
      artifacts_enc: string | null; tags_enc: string | null; session_id_enc: string | null;
      parent_event_id_enc: string | null; idempotency_key: string | null;
    }[] = [];

    for (const ev of events) {
      if (ev.idempotency_key) {
        const existing = existingByKey.get(ev.idempotency_key);
        if (existing) {
          accepted.push({ ...existing, duplicate: true });
          continue;
        }
      }
      nextSeq += 1;
      toInsert.push({
        event_id: ev.event_id, ledger_sequence: nextSeq,
        client_timestamp: ev.client_timestamp, domain_pseudonym: ev.domain_pseudonym,
        platform_enc: ev.platform_enc ?? null, summary_enc: ev.summary_enc,
        intent_enc: ev.intent_enc ?? null, outcome_enc: ev.outcome_enc ?? null,
        detail_enc: ev.detail_enc ?? null, artifacts_enc: ev.artifacts_enc ?? null,
        tags_enc: ev.tags_enc ?? null, session_id_enc: ev.session_id_enc ?? null,
        parent_event_id_enc: ev.parent_event_id_enc ?? null, idempotency_key: ev.idempotency_key ?? null,
      });
      accepted.push({ event_id: ev.event_id, ledger_sequence: nextSeq, duplicate: false });
    }

    if (toInsert.length > 0) {
      // Build a single multi-row INSERT. 15 columns per row.
      const cols = 15;
      const valuesSql = toInsert
        .map((_, i) => {
          const base = i * cols;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
                 `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
                 `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
        })
        .join(", ");
      const params: any[] = [];
      for (const r of toInsert) {
        params.push(
          userPublicKey, r.event_id, r.ledger_sequence, r.client_timestamp, r.domain_pseudonym,
          r.platform_enc, r.summary_enc, r.intent_enc, r.outcome_enc, r.detail_enc,
          r.artifacts_enc, r.tags_enc, r.session_id_enc, r.parent_event_id_enc, r.idempotency_key
        );
      }
      await client.query(
        `INSERT INTO timeline_events
           (user_public_key, event_id, ledger_sequence, client_timestamp, domain_pseudonym,
            platform_enc, summary_enc, intent_enc, outcome_enc, detail_enc, artifacts_enc,
            tags_enc, session_id_enc, parent_event_id_enc, idempotency_key)
         VALUES ${valuesSql}
         ON CONFLICT (user_public_key, event_id) DO NOTHING`,
        params
      );
    }

    return { accepted, cursor: nextSeq };
  });
}

async function pushWithRetry(
  db: Db,
  userPublicKey: string,
  events: PushedEvent[],
  retries = 3,
  backoffMs = 50
): Promise<PushResult> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await pushAtomic(db, userPublicKey, events);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Retry on Postgres deadlock (40P01) or serialization failure (40001).
      // The UNIQUE INDEX on (user_public_key, ledger_sequence) also causes
      // 23505 on a race; retry lets the second push re-read MAX and succeed.
      const isRetryable =
        msg.includes("40P01") || msg.includes("40001") ||
        msg.includes("23505") || msg.includes("deadlock") ||
        msg.includes("unique constraint") || msg.includes("duplicate key");
      if (isRetryable && attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

// --- Helpers ---

/**
 * Send a 409 VERSION_CONFLICT if expected is set and doesn't match current.
 * Returns true when the caller should stop processing.
 */
function replyVersionConflictIfMismatch(
  reply: FastifyReply,
  scope: string,
  currentVersion: number,
  expectedVersion: number | undefined,
  target?: string
): boolean {
  if (expectedVersion === undefined) return false;
  if (currentVersion === expectedVersion) return false;
  reply.code(409).send({
    error: "VERSION_CONFLICT",
    scope,
    ...(target !== undefined ? { target } : {}),
    current_version: currentVersion,
    expected_version: expectedVersion,
  });
  return true;
}

async function tryAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  rawBody: string
): Promise<{ userPublicKey: string } | null> {
  try {
    const method = req.method;
    // Fastify normalizes URL; we sign the path + query string
    const path = req.url; // includes query string
    return await verifyAndClaim(db, req.headers as any, method, path, rawBody);
  } catch (err) {
    if (err instanceof AuthError) {
      reply.code(err.status).send({ error: err.code, message: err.message });
      return null;
    }
    throw err;
  }
}

function numberQuery(q: Record<string, unknown>, name: string): number | undefined {
  const v = q[name];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
