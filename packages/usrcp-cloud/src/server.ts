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
import type { AuthenticatedRequest } from "./auth.js";
import { registerStreamRoutes } from "./stream.js";
import { registerPairingRoutes } from "./pairing.js";
import { registerRotateRoutes } from "./rotate.js";
import {
  registerRateLimits,
  createRateLimitState,
  loadConfigFromEnv,
  type RateLimitConfig,
  type RateLimitState,
} from "./rate-limit.js";

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

const DomainMapItem = z.object({
  pseudonym: z.string().min(1).max(128),
  encrypted_name: z.string().min(1).max(8192),
  version: z.number().int().min(1).default(1),
});

const AppendEventsBody = z.object({
  events: z.array(EventSchema).min(1).max(500),
  domain_maps: z.array(DomainMapItem).max(500).optional(),
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
  /**
   * Rate-limit configuration. When omitted, defaults are loaded from
   * env (see rate-limit.ts loadConfigFromEnv). Pass `false` to disable
   * rate limiting entirely (used in tests that exercise per-route
   * behavior without the limiter interfering).
   */
  rateLimit?: RateLimitConfig | false;
}

export interface CreateAppResult {
  app: FastifyInstance;
  rateLimitState: RateLimitState | null;
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

  // Per-IP rate limiting + brute-force detection. Registered before any
  // route so it runs in preHandler ordering ahead of the auth check.
  // Test callers pass `rateLimit: false` to bypass the limiter; the
  // production entry point in index.ts loads the env-driven config.
  let rateLimitState: RateLimitState | null = null;
  if (opts.rateLimit !== false) {
    const config = opts.rateLimit ?? loadConfigFromEnv();
    rateLimitState = createRateLimitState(config);
    registerRateLimits(app, rateLimitState);
  }
  (app as unknown as { rateLimitState?: RateLimitState | null }).rateLimitState = rateLimitState;

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

  // Generic error boundary (#177). Without it, Fastify's default handler
  // serialized thrown pg errors verbatim, echoing raw SQL statements and
  // driver internals to the client. Database conflicts map to a generic
  // 409; everything else unexpected is a generic 500. Full detail still
  // goes to the server log.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const pgCode = (err as { code?: unknown }).code;
    const msg = err instanceof Error ? err.message : String(err);
    // 23xxx = Postgres integrity-constraint violations (23505 unique, 23503
    // FK, ...). pg-mem throws plain Errors, so match its message shape too.
    const isConstraint =
      (typeof pgCode === "string" && pgCode.startsWith("23")) ||
      msg.includes("unique constraint") || msg.includes("duplicate key") ||
      msg.includes("violates foreign key");
    if (isConstraint) {
      return reply.code(409).send({
        error: "CONFLICT",
        message: "The write conflicts with existing state.",
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      // Fastify-generated client errors (bad content type, body limit, ...)
      // are safe to surface as-is; they contain no SQL.
      return reply.code(statusCode).send({ error: "BAD_REQUEST", message: msg });
    }
    return reply.code(500).send({ error: "INTERNAL", message: "Internal server error" });
  });

  // --- GET /healthz — unauthenticated ---
  app.get("/healthz", async () => ({ status: "ok" }));

  // --- GET /v1/state ---
  app.get("/v1/state", async (req, reply) => {
    const auth = await tryAuth(req, reply, db, "");
    if (!auth) return;
    const since = numberQuery(req.query as any, "since") ?? 0;
    // Floor at 1: ?limit=0 used to return an empty page with has_more:true
    // and an unchanged cursor, spinning any client that loops on has_more.
    const limit = Math.min(Math.max(numberQuery(req.query as any, "limit") ?? 500, 1), 500);

    const [events, identity, preferences, domainContexts, projects, facts, domainMaps] = await Promise.all([
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
      // Always return all domain_maps — tiny payload, enables fresh-device sync.
      db.query(
        `SELECT pseudonym, encrypted_name, version FROM domain_maps WHERE user_public_key = $1`,
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
      domain_maps: domainMaps.rows,
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

    return pushWithRetry(db, auth.userPublicKey, parse.data.events, parse.data.domain_maps ?? []);
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

    // #170: the whole update is atomic. Two defenses layered:
    //   (1) check-all-then-write: every expected_version is read and
    //       verified BEFORE the first write, so a conflict in any section
    //       aborts with 409 having written nothing. This holds on any
    //       backend, including ones without transactional rollback.
    //   (2) the writes then run inside ONE transaction, so a mid-write
    //       failure (constraint, disconnect) also rolls the batch back on
    //       real Postgres.
    // The pre-fix handler wrote each section directly and returned on the
    // first conflict, silently committing every earlier section.
    const CHUNK_SIZE = 50;
    type FactRow = { fact_id: string; domain_pseudonym: string; ns_key_hash: string; version: number };

    try {
      // ---- Phase 1: read current versions + verify all conflicts (no writes) ----
      let identityVersion = 0;
      if (body.identity) {
        const cur = await db.query(
          "SELECT version FROM core_identity WHERE user_public_key = $1",
          [auth.userPublicKey]
        );
        identityVersion = Number(cur.rows[0]?.version ?? 0);
        throwIfVersionMismatch("core_identity", identityVersion, body.identity.expected_version);
      }

      let preferencesVersion = 0;
      if (body.preferences) {
        const cur = await db.query(
          "SELECT version FROM global_preferences WHERE user_public_key = $1",
          [auth.userPublicKey]
        );
        preferencesVersion = Number(cur.rows[0]?.version ?? 0);
        throwIfVersionMismatch("global_preferences", preferencesVersion, body.preferences.expected_version);
      }

      const contextVersions = new Map<string, number>();
      for (const ctx of body.domain_contexts ?? []) {
        const cur = await db.query(
          "SELECT version FROM domain_context WHERE user_public_key = $1 AND domain_pseudonym = $2",
          [auth.userPublicKey, ctx.domain_pseudonym]
        );
        const currentVersion = Number(cur.rows[0]?.version ?? 0);
        throwIfVersionMismatch("domain_context", currentVersion, ctx.expected_version, ctx.domain_pseudonym);
        contextVersions.set(ctx.domain_pseudonym, currentVersion);
      }

      // Facts: snapshot existing rows by BOTH identities. The PK is
      // (user_public_key, fact_id) but the client-meaningful upsert key is
      // UNIQUE (user, domain_pseudonym, ns_key_hash). Classifying by ns-key
      // alone treated a reused fact_id under a new ns_key_hash as an insert
      // and hit the PK with a raw 23505 500 (#177).
      let resolveExisting: (f: { fact_id: string; domain_pseudonym: string; ns_key_hash: string }) => FactRow | undefined =
        () => undefined;
      if (body.facts && body.facts.length > 0) {
        const curRows: FactRow[] = [];
        for (let i = 0; i < body.facts.length; i += CHUNK_SIZE) {
          const chunk = body.facts.slice(i, i + CHUNK_SIZE);
          const orClauses = chunk.map((_, idx) => `(domain_pseudonym = $${idx * 2 + 2} AND ns_key_hash = $${idx * 2 + 3})`).join(' OR ');
          const params = [auth.userPublicKey];
          for (const f of chunk) {
            params.push(f.domain_pseudonym, f.ns_key_hash);
          }
          const chunkRes = await db.query<FactRow>(
            `SELECT fact_id, domain_pseudonym, ns_key_hash, version FROM schemaless_facts WHERE user_public_key = $1 AND (${orClauses})`,
            params
          );
          curRows.push(...chunkRes.rows);
        }
        for (let i = 0; i < body.facts.length; i += CHUNK_SIZE) {
          const ids = body.facts.slice(i, i + CHUNK_SIZE).map((f) => f.fact_id);
          const idRes = await db.query<FactRow>(
            `SELECT fact_id, domain_pseudonym, ns_key_hash, version FROM schemaless_facts
             WHERE user_public_key = $1 AND fact_id = ANY($2::text[])`,
            [auth.userPublicKey, ids]
          );
          curRows.push(...idRes.rows);
        }

        const existingByNsKey = new Map<string, FactRow>();
        const existingByFactId = new Map<string, FactRow>();
        for (const row of curRows) {
          existingByNsKey.set(row.domain_pseudonym + '/' + row.ns_key_hash, row);
          existingByFactId.set(row.fact_id, row);
        }
        // A fact resolves to the row its fact_id already names (the PK), else
        // the row holding its ns-key. fact_id wins: an UPDATE targets the PK,
        // so that is the row the write will actually land on.
        resolveExisting = (f) =>
          existingByFactId.get(f.fact_id) ?? existingByNsKey.get(f.domain_pseudonym + '/' + f.ns_key_hash);

        for (const f of body.facts) {
          const currentVersion = Number(resolveExisting(f)?.version ?? 0);
          throwIfVersionMismatch("schemaless_facts", currentVersion, f.expected_version, `${f.domain_pseudonym}/${f.ns_key_hash}`);
        }
      }

      // ---- Phase 2: all writes in one transaction ----
      await db.transaction(async (client) => {
        if (body.identity) {
          await client.query(
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
              identityVersion + 1,
            ]
          );
        }

        if (body.preferences) {
          await client.query(
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
              preferencesVersion + 1,
            ]
          );
        }

        for (const ctx of body.domain_contexts ?? []) {
          await client.query(
            `INSERT INTO domain_context (user_public_key, domain_pseudonym, context_enc, version)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_public_key, domain_pseudonym) DO UPDATE SET
               context_enc = EXCLUDED.context_enc,
               version = EXCLUDED.version,
               updated_at = now()`,
            [auth.userPublicKey, ctx.domain_pseudonym, ctx.context_enc, (contextVersions.get(ctx.domain_pseudonym) ?? 0) + 1]
          );
        }

        if (body.facts && body.facts.length > 0) {
          // Fold repeats by BOTH identities so one batch never writes the
          // same ns-key or the same PK twice (the second raw-23505 500 in
          // #177). Last write wins.
          const foldedByNsKey = new Map<string, typeof body.facts[number]>();
          for (const f of body.facts) {
            foldedByNsKey.set(f.domain_pseudonym + '/' + f.ns_key_hash, f);
          }
          const foldedFacts = new Map<string, typeof body.facts[number]>();
          for (const f of foldedByNsKey.values()) {
            foldedFacts.set(f.fact_id, f);
          }

          const updates = [];
          const inserts = [];
          for (const f of foldedFacts.values()) {
            const existing = resolveExisting(f);
            if (existing) updates.push({ f, existing });
            else inserts.push(f);
          }

          const queryPromises = [];
          // domain_pseudonym / ns_key_hash are written too so a fact_id
          // reused under a new ns-key moves the row instead of stranding the
          // old key.
          for (const u of updates) {
            queryPromises.push(client.query(
              `UPDATE schemaless_facts
                 SET namespace_enc = $1, key_enc = $2, value_enc = $3,
                     domain_pseudonym = $4, ns_key_hash = $5,
                     version = $6, updated_at = now()
               WHERE user_public_key = $7 AND fact_id = $8`,
              [
                u.f.namespace_enc, u.f.key_enc, u.f.value_enc,
                u.f.domain_pseudonym, u.f.ns_key_hash,
                Number(u.existing.version ?? 0) + 1,
                auth.userPublicKey, u.existing.fact_id,
              ]
            ));
          }

          if (inserts.length > 0) {
            const cols = 7;
            for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
              const chunk = inserts.slice(i, i + CHUNK_SIZE);
              const insertValues = chunk.map((_, idx) => `($${idx * cols + 1}, $${idx * cols + 2}, $${idx * cols + 3}, $${idx * cols + 4}, $${idx * cols + 5}, $${idx * cols + 6}, $${idx * cols + 7}, 1)`).join(', ');
              const insertParams = [];
              for (const f of chunk) {
                insertParams.push(auth.userPublicKey, f.fact_id, f.domain_pseudonym, f.ns_key_hash, f.namespace_enc, f.key_enc, f.value_enc);
              }
              queryPromises.push(client.query(`INSERT INTO schemaless_facts (user_public_key, fact_id, domain_pseudonym, ns_key_hash, namespace_enc, key_enc, value_enc, version) VALUES ${insertValues}`, insertParams));
            }
          }

          if (queryPromises.length > 0) {
            await Promise.all(queryPromises);
          }
        }

        // Projects: simple LWW on the row (no version col in Phase 1)
        for (const p of body.projects ?? []) {
          await client.query(
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
      });
    } catch (err) {
      if (err instanceof VersionConflictError) {
        // Detected in phase 1: nothing was written (#170).
        return reply.code(409).send(err.payload);
      }
      throw err;
    }

    return { status: "ok" };
  });

  // Stream sync routes live in a sibling module; same auth, same db.
  registerStreamRoutes(app, db);

  // Multi-device pairing endpoints (POST /v1/pairing/init, GET claim, etc.)
  registerPairingRoutes(app, db);

  // Identity rotation endpoint (POST /v1/rotate-identity).
  registerRotateRoutes(app, db);

  return app;
}

// --- Push helpers ---

type PushedEvent = z.infer<typeof EventSchema>;
type PushedDomainMap = z.infer<typeof DomainMapItem>;

type PushResult = {
  accepted: { event_id: string; ledger_sequence: number; duplicate: boolean }[];
  cursor: number;
};

async function pushAtomic(
  db: Db,
  userPublicKey: string,
  events: PushedEvent[],
  domainMaps: PushedDomainMap[]
): Promise<PushResult> {
  return db.transaction(async (client) => {
    // Lock the user row for the duration of this transaction. Any concurrent
    // push for the same user blocks here until we COMMIT, eliminating the
    // TOCTOU window between SELECT MAX(ledger_sequence) and INSERT.
    await client.query(
      "SELECT public_key FROM users WHERE public_key = $1 FOR UPDATE",
      [userPublicKey]
    );

    // Upsert domain_maps first — pulling device needs them before events.
    // Only advance version on conflict (last-write-wins by version number).
    if (domainMaps.length > 0) {
      // De-duplicate in memory first: keep the highest version for each pseudonym.
      // This avoids Postgres error: ON CONFLICT DO UPDATE command cannot affect the same row twice.
      const map = new Map<string, PushedDomainMap>();
      for (const dm of domainMaps) {
        const existing = map.get(dm.pseudonym);
        if (!existing || dm.version >= existing.version) {
          map.set(dm.pseudonym, dm);
        }
      }
      const deduped = Array.from(map.values());

      const cols = 4;
      const valuesSql = deduped
        .map((_, i) => {
          const base = i * cols;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        })
        .join(", ");
      const params: any[] = [];
      for (const dm of deduped) {
        params.push(userPublicKey, dm.pseudonym, dm.encrypted_name, dm.version);
      }

      await client.query(
        `INSERT INTO domain_maps (user_public_key, pseudonym, encrypted_name, version)
         VALUES ${valuesSql}
         ON CONFLICT (user_public_key, pseudonym) DO UPDATE SET
           encrypted_name = EXCLUDED.encrypted_name,
           version = EXCLUDED.version,
           updated_at = now()
         WHERE domain_maps.version <= EXCLUDED.version`,
        params
      );
    }

    const maxSeqResult = await client.query<{ max_seq: string }>(
      `SELECT COALESCE(MAX(ledger_sequence), 0) AS max_seq
       FROM timeline_events WHERE user_public_key = $1`,
      [userPublicKey]
    );
    let nextSeq = Number(maxSeqResult.rows[0]?.max_seq ?? 0);

    // Pre-check event_ids the same way stream.ts does (#177): sequences used
    // to be allocated before an ON CONFLICT (user_public_key, event_id)
    // DO NOTHING insert, so re-pushing an existing event_id returned a
    // fabricated fresh sequence with duplicate:false while the row silently
    // kept its old one (permanent sequence gap + false success; divergent
    // ciphertext for the same id was discarded but reported written).
    const existingById = new Map<string, { event_id: string; ledger_sequence: number }>();
    if (events.length > 0) {
      const idResult = await client.query<{ event_id: string; ledger_sequence: number }>(
        `SELECT event_id, ledger_sequence
         FROM timeline_events
         WHERE user_public_key = $1 AND event_id = ANY($2::text[])`,
        [userPublicKey, events.map((e) => e.event_id)]
      );
      for (const row of idResult.rows) {
        existingById.set(row.event_id, {
          event_id: row.event_id,
          ledger_sequence: Number(row.ledger_sequence),
        });
      }
    }

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
      // Duplicate event_id (already stored, or repeated within this batch):
      // report the REAL stored sequence with duplicate:true instead of
      // fabricating a new one.
      const byId = existingById.get(ev.event_id);
      if (byId) {
        accepted.push({ ...byId, duplicate: true });
        continue;
      }
      if (ev.idempotency_key) {
        const existing = existingByKey.get(ev.idempotency_key);
        if (existing) {
          accepted.push({ ...existing, duplicate: true });
          continue;
        }
      }
      nextSeq += 1;
      // Register the assigned sequence so a repeat of this event_id later in
      // the SAME batch reports duplicate:true instead of double-inserting
      // and blowing the (user_public_key, event_id) PK.
      existingById.set(ev.event_id, { event_id: ev.event_id, ledger_sequence: nextSeq });
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
         VALUES ${valuesSql}`,
        params
      );
      // No ON CONFLICT DO NOTHING: the pre-check above already classified
      // every duplicate, and same-user pushes serialize on the users FOR
      // UPDATE lock. If an unforeseen collision still happens, a loud 23505
      // rolls back and pushWithRetry re-runs the pre-check, instead of
      // silently dropping the row while reporting it accepted.
    }

    return { accepted, cursor: nextSeq };
  });
}

async function pushWithRetry(
  db: Db,
  userPublicKey: string,
  events: PushedEvent[],
  domainMaps: PushedDomainMap[],
  retries = 3,
  backoffMs = 50
): Promise<PushResult> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await pushAtomic(db, userPublicKey, events, domainMaps);
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
 * Version-conflict abort for POST /v1/state. Thrown inside the update
 * transaction so Db.transaction ROLLBACKs everything already written in
 * the request before the handler sends the 409 (#170); the pre-throw
 * reply-and-return shape committed all earlier sections.
 */
class VersionConflictError extends Error {
  readonly payload: Record<string, unknown>;
  constructor(scope: string, currentVersion: number, expectedVersion: number, target?: string) {
    super(`version conflict on ${scope}`);
    this.name = "VersionConflictError";
    this.payload = {
      error: "VERSION_CONFLICT",
      scope,
      ...(target !== undefined ? { target } : {}),
      current_version: currentVersion,
      expected_version: expectedVersion,
    };
  }
}

function throwIfVersionMismatch(
  scope: string,
  currentVersion: number,
  expectedVersion: number | undefined,
  target?: string
): void {
  if (expectedVersion === undefined) return;
  if (currentVersion === expectedVersion) return;
  throw new VersionConflictError(scope, currentVersion, expectedVersion, target);
}

export async function tryAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  rawBody: string
): Promise<AuthenticatedRequest | null> {
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

export function numberQuery(q: Record<string, unknown>, name: string): number | undefined {
  const v = q[name];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  // Only non-negative safe integers reach SQL. Anything else falls back to
  // the caller's default: a negative LIMIT or fractional bigint is a raw
  // Postgres error on real servers (pg-mem masks it in tests), and those
  // 500s echoed the SQL statement to the client (#177).
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
