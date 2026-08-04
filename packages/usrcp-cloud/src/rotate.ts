/**
 * Identity rotation endpoint.
 *
 * Lets a user rotate their Ed25519 identity from K1 to K2 in a single
 * atomic operation. The caller signs the POST with K1 (the OLD key) so
 * the endpoint is reachable only by someone who already controls the
 * current identity. The body carries the new public key K2 and a
 * detached Ed25519 signature by K1 over the canonical attestation
 *   "usrcp-rotate-v1\n" + K2_pem
 * so the cloud can verify that the rotation request was authored by
 * K1 rather than swapped in by a transport-level adversary.
 *
 * On success:
 *   1. Every child row in (timeline_events, core_identity, ...) that
 *      pointed at K1 is re-pointed at K2.
 *   2. The users row for K1 is replaced with K2 (preserving created_at).
 *   3. Stale pairing_bundles owned by K1 are deleted (they expire in
 *      <=30 min anyway and the rotated client has no way to claim them).
 *   4. revoked_keys gains a (K1 -> K2) row so the auth middleware
 *      rejects any future K1-signed request even if the attacker still
 *      holds K1's private key.
 *
 * See tasks/13-identity-rotation.md for the threat model.
 */

import type { FastifyInstance } from "fastify";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.js";
import { tryAuth } from "./server.js";
import { canonicalKeyId } from "./auth.js";

export const ROTATE_ATTESTATION_DOMAIN = "usrcp-rotate-v1";
// Domain-separated from ROTATE_ATTESTATION_DOMAIN: the OLD key signs over the
// new PEM (authorization), the NEW key signs over the old PEM (proof of
// possession). Distinct prefixes so neither signature can be replayed as the
// other even for a maliciously chosen key pair.
export const ROTATE_POP_DOMAIN = "usrcp-rotate-v1-pop";

const RotateBody = z.object({
  new_public_key: z.string().min(64).max(2048),
  rotation_attestation: z.string().min(64).max(2048),
  new_key_attestation: z.string().min(64).max(2048),
});

export function registerRotateRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/rotate-identity", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;
    // Canonical DER id for every DB key and every key-equality check; the PEM
    // is used only to parse the key for attestation verification (#176).
    const oldId = auth.userPublicKey;
    const oldPem = auth.publicKeyPem;

    const parse = RotateBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "BAD_BODY", issues: parse.error.issues });
    }
    const { new_public_key: newPub, rotation_attestation: attB64, new_key_attestation: popB64 } = parse.data;

    if (!newPub.includes("BEGIN PUBLIC KEY")) {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "Must be PEM Ed25519" });
    }

    // Parse keys and verify the attestation locally.
    let oldKey: crypto.KeyObject;
    let newKey: crypto.KeyObject;
    try {
      oldKey = crypto.createPublicKey(oldPem);
      newKey = crypto.createPublicKey(newPub);
    } catch {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "Failed to parse PEM" });
    }
    if (newKey.asymmetricKeyType !== "ed25519") {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "New key must be Ed25519" });
    }

    // Compare canonical ids, not PEM strings: a byte-variant of the old PEM
    // must still count as rotate-to-self, and the DB collision/revocation
    // checks below key off newId (#176).
    const newId = canonicalKeyId(newKey);
    if (newId === oldId) {
      return reply.code(400).send({ error: "ROTATE_TO_SELF", message: "New key must differ from old key" });
    }

    let attBytes: Buffer;
    try {
      attBytes = Buffer.from(attB64, "base64url");
    } catch {
      return reply.code(400).send({ error: "BAD_ATTESTATION", message: "Must be base64url" });
    }

    const canon = Buffer.from(`${ROTATE_ATTESTATION_DOMAIN}\n${newPub}`, "utf8");
    let attOk = false;
    try {
      attOk = crypto.verify(null, canon, oldKey, attBytes);
    } catch {
      attOk = false;
    }
    if (!attOk) {
      return reply.code(401).send({
        error: "BAD_ATTESTATION",
        message: "rotation_attestation must be Ed25519 signature by the OLD key over `usrcp-rotate-v1\\n<new_pem>`",
      });
    }

    // Proof of possession of the NEW key (#177). Without this, a typo'd or
    // attacker-substituted new_public_key moves every row to a key the user
    // cannot sign with, and the old key is revoked in the same transaction,
    // permanently bricking the account with no recovery path. The new key
    // must counter-sign the OLD key's exact request PEM so only someone
    // holding the new private half can complete the rotation.
    let popBytes: Buffer;
    try {
      popBytes = Buffer.from(popB64, "base64url");
    } catch {
      return reply.code(400).send({ error: "BAD_NEW_KEY_ATTESTATION", message: "Must be base64url" });
    }
    const popCanon = Buffer.from(`${ROTATE_POP_DOMAIN}\n${oldPem}`, "utf8");
    let popOk = false;
    try {
      popOk = crypto.verify(null, popCanon, newKey, popBytes);
    } catch {
      popOk = false;
    }
    if (!popOk) {
      return reply.code(401).send({
        error: "BAD_NEW_KEY_ATTESTATION",
        message: "new_key_attestation must be Ed25519 signature by the NEW key over `usrcp-rotate-v1-pop\\n<old_pem>`",
      });
    }

    // Refuse if the new key is already known: either as a live user
    // (collision) or as a previously-revoked key (rotating to a dead
    // key, which would lock the user out).
    const newCollision = await db.query<{ public_key: string }>(
      "SELECT public_key FROM users WHERE public_key = $1",
      [newId]
    );
    if (newCollision.rows.length > 0) {
      return reply.code(409).send({
        error: "NEW_KEY_IN_USE",
        message: "Another user is already using this public key",
      });
    }
    const newRevoked = await db.query<{ public_key: string }>(
      "SELECT public_key FROM revoked_keys WHERE public_key = $1",
      [newId]
    );
    if (newRevoked.rows.length > 0) {
      return reply.code(409).send({
        error: "NEW_KEY_REVOKED",
        message: "Cannot rotate to a previously-revoked key",
      });
    }

    // Atomic re-pointing: every child row moves from K1 to K2 inside a
    // single transaction. We INSERT the new user row first so child
    // FKs validate when we re-point, then DELETE the old user once no
    // child references it. pairing_bundles for K1 are stale by design
    // and dropped.
    //
    // Concurrent-rotation race: a second rotation request for the same
    // K1 can pass auth before the first commits, then block on SELECT
    // FOR UPDATE. After the first commits and deletes K1, the second
    // sees an empty users row and would otherwise proceed to overwrite
    // revoked_keys with stale data. We detect that by checking the
    // rowCount of the K2 INSERT-from-SELECT (0 means K1 was already
    // drained by a concurrent rotation) and abort with 409.
    let rotated = false;
    try {
      await db.transaction(async (client) => {
        await client.query(
          "SELECT public_key FROM users WHERE public_key = $1 FOR UPDATE",
          [oldId]
        );
        // Re-check revoked_keys INSIDE the transaction. Auth checked it
        // before the lock above, but a concurrent rotation could have
        // committed in the meantime (inserting K1 into revoked_keys and
        // deleting K1 from users). Auth's INSERT-ON-CONFLICT upsert can
        // then recreate K1 as an empty row before this transaction
        // runs, so the rowCount guard alone is not enough on real
        // Postgres. If K1 is now revoked, abort instead of "rotating"
        // a phantom empty K1 row to the caller's K2.
        const reRevoked = await client.query<{ public_key: string }>(
          "SELECT public_key FROM revoked_keys WHERE public_key = $1",
          [oldId]
        );
        if (reRevoked.rows.length > 0) {
          throw new Error("__CONCURRENT_ROTATION__");
        }
        // Copy created_at from old to new so the user's "I joined at" is
        // preserved. last_seen_at refreshes.
        const insertK2 = await client.query<{ public_key: string }>(
          `INSERT INTO users (public_key, created_at, last_seen_at)
           SELECT $2, created_at, now() FROM users WHERE public_key = $1
           RETURNING public_key`,
          [oldId, newId]
        );
        if (insertK2.rows.length === 0) {
          // K1's row vanished and auth didn't re-upsert it (e.g. rotate
          // called directly with no prior write). Same fail mode as the
          // revoked_keys check above.
          throw new Error("__CONCURRENT_ROTATION__");
        }

        // stream_events + stream_embeddings have a composite FK
        // (user_public_key, event_id) without ON UPDATE CASCADE, so a
        // naive UPDATE of the parent would orphan the embeddings rows.
        // INSERT-SELECT the K2 copies for both tables (parent first,
        // child second) before deleting the K1 rows.
        await client.query(
          `INSERT INTO stream_events
             (user_public_key, event_id, server_seq, client_timestamp, server_timestamp,
              surface, side, content_kind, ts_ms, channel_ref_enc, author_ref_enc,
              content_enc, entity_refs_enc, ingested_at, schema_v, embedding_present,
              idempotency_key)
           SELECT $2, event_id, server_seq, client_timestamp, server_timestamp,
                  surface, side, content_kind, ts_ms, channel_ref_enc, author_ref_enc,
                  content_enc, entity_refs_enc, ingested_at, schema_v, embedding_present,
                  idempotency_key
             FROM stream_events WHERE user_public_key = $1`,
          [oldId, newId]
        );
        await client.query(
          `INSERT INTO stream_embeddings
             (user_public_key, event_id, vec_enc, dims, model_enc, created_at_ms)
           SELECT $2, event_id, vec_enc, dims, model_enc, created_at_ms
             FROM stream_embeddings WHERE user_public_key = $1`,
          [oldId, newId]
        );
        // Delete child first then parent to respect the composite FK.
        await client.query("DELETE FROM stream_embeddings WHERE user_public_key = $1", [oldId]);
        await client.query("DELETE FROM stream_events WHERE user_public_key = $1", [oldId]);

        // Tables that only reference users(public_key) with ON DELETE
        // CASCADE: a plain UPDATE works because the K2 users row already
        // exists (so the FK target is valid) and the K1 row isn't deleted
        // yet (so the cascade doesn't fire).
        const tables = [
          "timeline_events",
          "core_identity",
          "global_preferences",
          "domain_context",
          "active_projects",
          "schemaless_facts",
          "domain_maps",
        ];
        for (const t of tables) {
          await client.query(
            `UPDATE ${t} SET user_public_key = $2 WHERE user_public_key = $1`,
            [oldId, newId]
          );
        }

        await client.query(
          "DELETE FROM pairing_bundles WHERE owner_public_key = $1",
          [oldId]
        );
        await client.query(
          "DELETE FROM seen_nonces WHERE user_public_key = $1",
          [oldId]
        );

        // Remove the old user row. No children remain.
        await client.query("DELETE FROM users WHERE public_key = $1", [oldId]);

        // Permanently revoke the old key so it can't recreate itself via
        // the upsert-on-write path the next time it signs a request.
        // Use ON CONFLICT DO NOTHING here so a parallel rotation race
        // can't overwrite the legitimate first rotation's pointer; the
        // concurrent-rotation check above is the primary guard, this is
        // just defense in depth.
        await client.query(
          `INSERT INTO revoked_keys (public_key, rotated_to)
           VALUES ($1, $2)
           ON CONFLICT (public_key) DO NOTHING`,
          [oldId, newId]
        );
      });
      rotated = true;
    } catch (err) {
      if (err instanceof Error && err.message === "__CONCURRENT_ROTATION__") {
        return reply.code(409).send({
          error: "CONCURRENT_ROTATION",
          message: "Old key was rotated by a concurrent request; refresh and try again.",
        });
      }
      throw err;
    }

    if (!rotated) {
      // Defense in depth; the try/catch above always sets rotated=true
      // on success or returns 409 on the race path.
      return reply.code(500).send({ error: "ROTATE_FAILED" });
    }

    return reply.code(200).send({
      ok: true,
      old_public_key: oldPem,
      new_public_key: newPub,
      revoked_at: new Date().toISOString(),
    });
  });
}
