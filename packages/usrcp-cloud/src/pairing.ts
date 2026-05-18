/**
 * Multi-device pairing endpoints (v2).
 *
 * The server stores client-encrypted bundles under a short-TTL row keyed
 * by the 8-digit pairing code. In v2 the decryption key is derived
 * client-side via HKDF-SHA256(IKM=secret, salt=code) where the 16-byte
 * `secret` travels device-to-device out of band and never reaches this
 * server. The route handlers below therefore see only the lookup code
 * and opaque ciphertext; the bundle plaintext (user identity files) is
 * cryptographically out of reach for the cloud, not just by convention.
 * See tasks/12-pair-tier-2.md for the threat model and the retired v1
 * design context in tasks/11-multi-device-pairing.md.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { tryAuth } from "./server.js";

const DEFAULT_TTL_SECONDS = 600; // 10 min
const MAX_TTL_SECONDS = 1800; // 30 min
const MAX_CLAIM_ATTEMPTS = 5;

const CODE_RE = /^[0-9]{8}$/;

const InitBody = z.object({
  code: z.string().regex(CODE_RE),
  encrypted_bundle: z.string().min(16).max(32_768),
  ttl_seconds: z.number().int().min(60).max(MAX_TTL_SECONDS).optional(),
});

export function registerPairingRoutes(app: FastifyInstance, db: Db): void {
  // POST /v1/pairing/init  - device A uploads an encrypted bundle.
  app.post("/v1/pairing/init", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;

    const parse = InitBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "BAD_BODY", issues: parse.error.issues });
    }
    const { code, encrypted_bundle, ttl_seconds } = parse.data;
    const ttl = ttl_seconds ?? DEFAULT_TTL_SECONDS;

    // Two-step: pre-check ownership, then upsert. A single
    // `ON CONFLICT ... WHERE pairing_bundles.owner_public_key = EXCLUDED.x`
    // is correct in real Postgres but ignored by pg-mem, so split it.
    // The 1e8 codespace + 10-min TTL keeps the cross-user collision rate
    // negligible; we accept the resulting TOCTOU window as documented.
    const existing = await db.query<{ owner_public_key: string }>(
      "SELECT owner_public_key FROM pairing_bundles WHERE code = $1 AND expires_at > now()",
      [code]
    );
    if (
      existing.rows.length > 0 &&
      existing.rows[0].owner_public_key !== auth.userPublicKey
    ) {
      return reply.code(409).send({
        error: "CODE_COLLISION",
        message: "Pairing code already in use by another user. Re-run init.",
      });
    }

    // The user_public_key must already exist in users; the auth middleware
    // upserts it before we get here, so the FK will always resolve.
    // ON CONFLICT lets the same owner replace their own pending bundle
    // (e.g. they re-ran `usrcp pair init` because the user lost the code).
    // Belt-and-suspenders against the concurrent-init TOCTOU: two POSTs from
    // different users for the same fresh code can both pass the pre-check;
    // the second hits the PK conflict, and without a predicate here the ON
    // CONFLICT path would silently transfer ownership. The WHERE clause
    // refuses the update unless either (a) same owner replacing own bundle
    // or (b) the prior row is expired, in which case taking it over is
    // fine. pg-mem ignores ON CONFLICT WHERE predicates, but the pre-check
    // above covers every case pg-mem can exercise; this clause is the
    // load-bearing guard in real Postgres under concurrent load.
    const insert = await db.query<{ expires_at: string }>(
      `INSERT INTO pairing_bundles (code, owner_public_key, encrypted_bundle, expires_at)
       VALUES ($1, $2, $3, now() + ($4::text || ' seconds')::interval)
       ON CONFLICT (code) DO UPDATE SET
         owner_public_key = EXCLUDED.owner_public_key,
         encrypted_bundle = EXCLUDED.encrypted_bundle,
         expires_at       = EXCLUDED.expires_at,
         claim_attempts   = 0,
         created_at       = now()
       WHERE pairing_bundles.owner_public_key = EXCLUDED.owner_public_key
          OR pairing_bundles.expires_at < now()
       RETURNING expires_at`,
      [code, auth.userPublicKey, encrypted_bundle, String(ttl)]
    );

    if (insert.rows.length === 0) {
      // Real-Postgres-only path: a concurrent init from another user
      // beat us to the PK between our pre-check and our INSERT. Surface
      // the same 409 as the pre-check would have. (pg-mem cannot reach
      // this branch because it ignores the ON CONFLICT WHERE predicate.)
      return reply.code(409).send({
        error: "CODE_COLLISION",
        message: "Pairing code raced with another user. Re-run init.",
      });
    }

    return { ok: true, expires_at: insert.rows[0].expires_at };
  });

  // GET /v1/pairing/claim/:code  - device B fetches by code; UN-authenticated
  // (device B has no identity yet). Increments claim_attempts; when it
  // hits the cap, the prune loop or the next call cleans the row up.
  //
  // The response intentionally omits `owner_public_key`. Anyone who
  // knows or guesses an 8-digit code can hit this endpoint without
  // authentication; returning the owner's identity key would let an
  // attacker pivot from "I have a code" to "and here's the long-lived
  // Ed25519 identity that posted it." Device B has never needed the
  // value (the bundle's identity.public_key field carries the same
  // information once decrypted, and that's authenticated by the
  // HKDF-derived bundle key the attacker can't derive). Codex Tier-2
  // #1.
  app.get("/v1/pairing/claim/:code", async (req, reply) => {
    const params = req.params as { code?: string };
    if (!params.code || !CODE_RE.test(params.code)) {
      return reply.code(400).send({ error: "BAD_CODE" });
    }

    // Single statement: increment attempts and read the row in one
    // round-trip. Skip rows whose attempts already hit the cap (and let
    // the periodic prune delete them) instead of deleting inline; this
    // keeps the GET path retry-safe under flaky networks.
    const result = await db.query<{
      encrypted_bundle: string;
      expires_at: string;
      claim_attempts: number;
    }>(
      `UPDATE pairing_bundles
       SET claim_attempts = claim_attempts + 1
       WHERE code = $1
         AND expires_at > now()
         AND claim_attempts < $2
       RETURNING encrypted_bundle, expires_at, claim_attempts`,
      [params.code, MAX_CLAIM_ATTEMPTS]
    );

    if (result.rows.length === 0) {
      // Distinguish "not found / expired" (404) from "rate-limited" (429)
      // by a follow-up read.
      const probe = await db.query<{ claim_attempts: number; expires_at: string }>(
        `SELECT claim_attempts, expires_at FROM pairing_bundles WHERE code = $1`,
        [params.code]
      );
      if (probe.rows.length > 0 && probe.rows[0].claim_attempts >= MAX_CLAIM_ATTEMPTS) {
        return reply.code(429).send({
          error: "TOO_MANY_ATTEMPTS",
          message: `Bundle locked after ${MAX_CLAIM_ATTEMPTS} attempts; ask device A to re-init.`,
        });
      }
      return reply.code(404).send({ error: "NOT_FOUND" });
    }

    const row = result.rows[0];
    return {
      encrypted_bundle: row.encrypted_bundle,
      expires_at: row.expires_at,
      attempts_remaining: MAX_CLAIM_ATTEMPTS - row.claim_attempts,
    };
  });

  // GET /v1/pairing/list  - owner inspects their own pending bundles.
  app.get("/v1/pairing/list", async (req, reply) => {
    const auth = await tryAuth(req, reply, db, "");
    if (!auth) return;
    const rows = await db.query<{
      code: string;
      expires_at: string;
      claim_attempts: number;
    }>(
      `SELECT code, expires_at, claim_attempts
       FROM pairing_bundles
       WHERE owner_public_key = $1 AND expires_at > now()
       ORDER BY created_at DESC`,
      [auth.userPublicKey]
    );
    return { bundles: rows.rows };
  });

  // DELETE /v1/pairing/:code  - owner cancels a pending bundle.
  app.delete("/v1/pairing/:code", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;
    const params = req.params as { code?: string };
    if (!params.code || !CODE_RE.test(params.code)) {
      return reply.code(400).send({ error: "BAD_CODE" });
    }
    const r = await db.query(
      `DELETE FROM pairing_bundles
       WHERE code = $1 AND owner_public_key = $2`,
      [params.code, auth.userPublicKey]
    );
    if ((r.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    return { ok: true };
  });
}

/**
 * Delete expired bundles and bundles that hit the claim cap. Called from
 * the same setInterval that prunes nonces in src/index.ts.
 */
export async function prunePairingBundles(db: Db): Promise<number> {
  const r = await db.query(
    `DELETE FROM pairing_bundles
     WHERE expires_at < now() OR claim_attempts >= $1`,
    [MAX_CLAIM_ATTEMPTS]
  );
  return r.rowCount ?? 0;
}

export const _internal = { MAX_CLAIM_ATTEMPTS, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS };
