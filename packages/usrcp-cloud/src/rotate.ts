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

export const ROTATE_ATTESTATION_DOMAIN = "usrcp-rotate-v1";

const RotateBody = z.object({
  new_public_key: z.string().min(64).max(2048),
  rotation_attestation: z.string().min(64).max(2048),
});

export function registerRotateRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/rotate-identity", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    const auth = await tryAuth(req, reply, db, raw);
    if (!auth) return;
    const oldPub = auth.userPublicKey;

    const parse = RotateBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "BAD_BODY", issues: parse.error.issues });
    }
    const { new_public_key: newPub, rotation_attestation: attB64 } = parse.data;

    if (!newPub.includes("BEGIN PUBLIC KEY")) {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "Must be PEM Ed25519" });
    }
    if (newPub === oldPub) {
      return reply.code(400).send({ error: "ROTATE_TO_SELF", message: "New key must differ from old key" });
    }

    // Parse keys and verify the attestation locally.
    let oldKey: crypto.KeyObject;
    let newKey: crypto.KeyObject;
    try {
      oldKey = crypto.createPublicKey(oldPub);
      newKey = crypto.createPublicKey(newPub);
    } catch {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "Failed to parse PEM" });
    }
    if (newKey.asymmetricKeyType !== "ed25519") {
      return reply.code(400).send({ error: "BAD_NEW_PUBLIC_KEY", message: "New key must be Ed25519" });
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

    // Refuse if the new key is already known: either as a live user
    // (collision) or as a previously-revoked key (rotating to a dead
    // key, which would lock the user out).
    const newCollision = await db.query<{ public_key: string }>(
      "SELECT public_key FROM users WHERE public_key = $1",
      [newPub]
    );
    if (newCollision.rows.length > 0) {
      return reply.code(409).send({
        error: "NEW_KEY_IN_USE",
        message: "Another user is already using this public key",
      });
    }
    const newRevoked = await db.query<{ public_key: string }>(
      "SELECT public_key FROM revoked_keys WHERE public_key = $1",
      [newPub]
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
    await db.transaction(async (client) => {
      await client.query(
        "SELECT public_key FROM users WHERE public_key = $1 FOR UPDATE",
        [oldPub]
      );
      // Copy created_at from old to new so the user's "I joined at" is
      // preserved. last_seen_at refreshes.
      await client.query(
        `INSERT INTO users (public_key, created_at, last_seen_at)
         SELECT $2, created_at, now() FROM users WHERE public_key = $1`,
        [oldPub, newPub]
      );

      const tables = [
        "timeline_events",
        "core_identity",
        "global_preferences",
        "domain_context",
        "active_projects",
        "schemaless_facts",
        "domain_maps",
        "stream_events",
        "stream_embeddings",
      ];
      for (const t of tables) {
        await client.query(
          `UPDATE ${t} SET user_public_key = $2 WHERE user_public_key = $1`,
          [oldPub, newPub]
        );
      }

      await client.query(
        "DELETE FROM pairing_bundles WHERE owner_public_key = $1",
        [oldPub]
      );
      await client.query(
        "DELETE FROM seen_nonces WHERE user_public_key = $1",
        [oldPub]
      );

      // Remove the old user row. No children remain.
      await client.query("DELETE FROM users WHERE public_key = $1", [oldPub]);

      // Permanently revoke the old key so it can't recreate itself via
      // the upsert-on-write path the next time it signs a request.
      await client.query(
        `INSERT INTO revoked_keys (public_key, rotated_to)
         VALUES ($1, $2)
         ON CONFLICT (public_key) DO UPDATE SET
           rotated_to = EXCLUDED.rotated_to,
           revoked_at = now()`,
        [oldPub, newPub]
      );
    });

    return reply.code(200).send({
      ok: true,
      old_public_key: oldPub,
      new_public_key: newPub,
      revoked_at: new Date().toISOString(),
    });
  });
}
