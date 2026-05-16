import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import * as crypto from "node:crypto";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import { createApp } from "../server.js";
import { signRequest } from "../auth.js";
import { ROTATE_ATTESTATION_DOMAIN } from "../rotate.js";

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  const env = makeMemDb();
  db = env.db;
  await db.migrate();
  app = createApp({ db, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

async function signedInject(
  privateKeyPem: string,
  publicKeyPem: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  bodyObj?: unknown
) {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const signed = signRequest(privateKeyPem, method, url, body);
  const injectOpts: Record<string, unknown> = {
    method,
    url,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
  };
  if (bodyObj !== undefined) injectOpts.payload = body;
  return app.inject(injectOpts as Parameters<FastifyInstance["inject"]>[0]);
}

function attestRotation(oldPrivateKeyPem: string, newPublicKeyPem: string): string {
  const canon = Buffer.from(`${ROTATE_ATTESTATION_DOMAIN}\n${newPublicKeyPem}`, "utf8");
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(oldPrivateKeyPem));
  return sig.toString("base64url");
}

// Seed Alice with a row in users, a timeline event, and an identity row.
async function seedUser(publicKeyPem: string, privateKeyPem: string) {
  // First signed write registers the user via auth's upsert.
  const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
    identity: { display_name_enc: "enc:ALICE_DISPLAY_NAME_LONG_ENOUGH" },
  });
  expect(res.statusCode).toBe(200);

  // And an event.
  await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
    events: [{
      event_id: "ev_pre_rotation",
      client_timestamp: new Date().toISOString(),
      domain_pseudonym: "abcdef1234567890abcdef1234567890",
      summary_enc: "enc:SUMMARY_BEFORE_ROTATION_LONG_ENOUGH",
    }],
  });
}

describe("POST /v1/rotate-identity", () => {
  it("moves all user data to the new key and revokes the old key", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);

    const att = attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem);
    const rot = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: att,
    });
    expect(rot.statusCode).toBe(200);
    const body = rot.json();
    expect(body.ok).toBe(true);
    expect(body.old_public_key).toBe(alice.publicKeyPem);
    expect(body.new_public_key).toBe(aliceNew.publicKeyPem);

    // The new key can read the existing event.
    const stateRes = await signedInject(aliceNew.privateKeyPem, aliceNew.publicKeyPem, "GET", "/v1/state");
    expect(stateRes.statusCode).toBe(200);
    const state = stateRes.json();
    expect(state.events.length).toBe(1);
    expect(state.events[0].event_id).toBe("ev_pre_rotation");
    expect(state.identity?.display_name_enc).toBe("enc:ALICE_DISPLAY_NAME_LONG_ENOUGH");

    // The OLD key is revoked: every signed request comes back 401 KEY_REVOKED.
    const oldStateRes = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(oldStateRes.statusCode).toBe(401);
    expect(oldStateRes.json().error).toBe("KEY_REVOKED");

    // The users table has only the new key.
    const users = await db.query<{ public_key: string }>("SELECT public_key FROM users");
    expect(users.rows.map((r) => r.public_key).sort()).toEqual([aliceNew.publicKeyPem].sort());

    // revoked_keys records the rotation pointer.
    const revoked = await db.query<{ public_key: string; rotated_to: string | null }>(
      "SELECT public_key, rotated_to FROM revoked_keys"
    );
    expect(revoked.rows.length).toBe(1);
    expect(revoked.rows[0].public_key).toBe(alice.publicKeyPem);
    expect(revoked.rows[0].rotated_to).toBe(aliceNew.publicKeyPem);
  });

  it("rejects rotation when attestation is missing/wrong", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    const bob = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);

    // Bob signs the attestation - that's not the old key, so it must fail.
    const badAtt = attestRotation(bob.privateKeyPem, aliceNew.publicKeyPem);
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: badAtt,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("BAD_ATTESTATION");

    // The old key is still alive (rotation never happened).
    const stillAliveRes = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(stillAliveRes.statusCode).toBe(200);
  });

  it("rejects rotation to the same key", async () => {
    const alice = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);
    const att = attestRotation(alice.privateKeyPem, alice.publicKeyPem);
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: alice.publicKeyPem,
      rotation_attestation: att,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ROTATE_TO_SELF");
  });

  it("rejects rotation to a key already in use by another user", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);
    await seedUser(bob.publicKeyPem, bob.privateKeyPem);

    const att = attestRotation(alice.privateKeyPem, bob.publicKeyPem);
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: bob.publicKeyPem,
      rotation_attestation: att,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NEW_KEY_IN_USE");
  });

  it("rejects rotation to a previously-revoked key", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    const aliceNewer = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);

    // First rotation: alice -> aliceNew. alice is now revoked.
    const att1 = attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem);
    const r1 = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: att1,
    });
    expect(r1.statusCode).toBe(200);

    // Attempt to rotate aliceNew BACK to alice's old key (which is revoked).
    const att2 = attestRotation(aliceNew.privateKeyPem, alice.publicKeyPem);
    const r2 = await signedInject(aliceNew.privateKeyPem, aliceNew.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: alice.publicKeyPem,
      rotation_attestation: att2,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe("NEW_KEY_REVOKED");

    // Rotate aliceNew -> aliceNewer; should succeed.
    const att3 = attestRotation(aliceNew.privateKeyPem, aliceNewer.publicKeyPem);
    const r3 = await signedInject(aliceNew.privateKeyPem, aliceNew.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNewer.publicKeyPem,
      rotation_attestation: att3,
    });
    expect(r3.statusCode).toBe(200);

    // Both alice AND aliceNew are revoked now.
    const revoked = await db.query<{ public_key: string; rotated_to: string | null }>(
      "SELECT public_key, rotated_to FROM revoked_keys ORDER BY revoked_at ASC"
    );
    expect(revoked.rows.length).toBe(2);
    expect(revoked.rows.map((r) => r.public_key)).toEqual([alice.publicKeyPem, aliceNew.publicKeyPem]);
  });

  it("rejects unsigned rotation requests", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    const res = await app.inject({
      method: "POST",
      url: "/v1/rotate-identity",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        new_public_key: aliceNew.publicKeyPem,
        rotation_attestation: attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem),
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("drops pending pairing_bundles for the old key during rotation", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);

    // Alice creates a pending pairing bundle.
    const pairRes = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "11111111",
      encrypted_bundle: "enc:DUMMY_BUNDLE_LONG_ENOUGH_FOR_VALIDATION",
    });
    expect(pairRes.statusCode).toBe(200);

    // Rotate.
    const att = attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem);
    const rot = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: att,
    });
    expect(rot.statusCode).toBe(200);

    // The pending bundle for alice's old key is gone.
    const bundles = await db.query("SELECT 1 FROM pairing_bundles WHERE code = $1", ["11111111"]);
    expect(bundles.rows.length).toBe(0);
  });
});

describe("auth middleware rejects revoked keys", () => {
  it("revoked key is rejected on every signed endpoint", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    await seedUser(alice.publicKeyPem, alice.privateKeyPem);

    const att = attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem);
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: att,
    });

    // Every authenticated endpoint should return 401 KEY_REVOKED for alice.
    for (const url of ["/v1/state", "/v1/pairing/list"]) {
      const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", url);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("KEY_REVOKED");
    }

    // POST writes are also rejected.
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [{
        event_id: "ev_after_rotation",
        client_timestamp: new Date().toISOString(),
        domain_pseudonym: "abcdef1234567890abcdef1234567890",
        summary_enc: "enc:AFTER_ROTATION_TRY",
      }],
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("KEY_REVOKED");

    // The revoked key did NOT create a phantom users row.
    const phantom = await db.query("SELECT public_key FROM users WHERE public_key = $1", [alice.publicKeyPem]);
    expect(phantom.rows.length).toBe(0);
  });
});
