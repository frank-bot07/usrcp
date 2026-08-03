import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import { createApp } from "../server.js";
import * as crypto from "node:crypto";
import { signRequest, canonicalKeyId } from "../auth.js";

// DB identity is the canonical SPKI-DER id, not the PEM (#176).
const canonId = (pem: string): string => canonicalKeyId(crypto.createPublicKey(pem));
import { prunePairingBundles } from "../pairing.js";

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
): Promise<ReturnType<FastifyInstance["inject"]>> {
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

const ALICE_BUNDLE = "enc:OPAQUE_ENCRYPTED_BUNDLE_FROM_DEVICE_A";

// Placeholder ciphertexts must satisfy the route's >=16-char min.
function bundle(tag: string): string {
  return "enc:PLACEHOLDER_BUNDLE_" + tag;
}

describe("POST /v1/pairing/init", () => {
  it("rejects unsigned requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pairing/init",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code: "12345678", encrypted_bundle: ALICE_BUNDLE }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed init and returns expires_at", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    // First write so user exists (auth upserts on any signed call, but
    // an /v1/pairing/init signed call ALSO creates the user via the
    // same upsert; this comment is for the reader).
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "12345678",
      encrypted_bundle: ALICE_BUNDLE,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.expires_at).toBe("string");
  });

  it("rejects bad 8-digit codes", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    for (const bad of ["1234567", "123456789", "abcdefgh", "1234-5678"]) {
      const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
        code: bad,
        encrypted_bundle: ALICE_BUNDLE,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects ttl_seconds above the cap", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "11111111",
      encrypted_bundle: ALICE_BUNDLE,
      ttl_seconds: 999999,
    });
    expect(res.statusCode).toBe(400);
  });

  it("the same owner can replace their own pending bundle (ON CONFLICT)", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "22222222",
      encrypted_bundle: bundle("FIRST"),
    });
    const second = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "22222222",
      encrypted_bundle: bundle("SECOND"),
    });
    expect(second.statusCode).toBe(200);
    const probe = await db.query("SELECT encrypted_bundle, claim_attempts FROM pairing_bundles WHERE code = $1", ["22222222"]);
    expect(probe.rows[0].encrypted_bundle).toBe(bundle("SECOND"));
    expect(probe.rows[0].claim_attempts).toBe(0);
  });

  it("transfers ownership when a different owner posts the same EXPIRED code", async () => {
    // An expired-but-not-yet-pruned row from alice must not leak ownership
    // to bob if bob posts the same code. The pre-check only matches LIVE
    // rows, so the ON CONFLICT path executes; that path must rewrite
    // owner_public_key, otherwise bob's `pair status`/`cancel` won't see
    // the new bundle and alice could cancel it.
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "33330000",
      encrypted_bundle: bundle("ALICE_EXPIRED"),
    });
    await db.query(
      "UPDATE pairing_bundles SET expires_at = $1 WHERE code = $2",
      [new Date(Date.now() - 60_000).toISOString(), "33330000"]
    );

    const res = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "33330000",
      encrypted_bundle: bundle("BOB_FRESH"),
    });
    expect(res.statusCode).toBe(200);

    const row = await db.query<{ owner_public_key: string; encrypted_bundle: string }>(
      "SELECT owner_public_key, encrypted_bundle FROM pairing_bundles WHERE code = $1",
      ["33330000"]
    );
    // Owner must now be bob (not alice).
    const bobPubFromHeader = canonId(bob.publicKeyPem); // canonical id as stored
    expect(row.rows[0].owner_public_key).toBe(bobPubFromHeader);
    expect(row.rows[0].encrypted_bundle).toBe(bundle("BOB_FRESH"));

    // Sanity: alice's `list` no longer sees the row, bob's does.
    const aliceList = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/pairing/list");
    const aliceCodes = (aliceList.json().bundles as { code: string }[]).map((b) => b.code);
    expect(aliceCodes).not.toContain("33330000");
    const bobList = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "GET", "/v1/pairing/list");
    const bobCodes = (bobList.json().bundles as { code: string }[]).map((b) => b.code);
    expect(bobCodes).toContain("33330000");
  });

  it("a DIFFERENT owner cannot overwrite an existing code (409 CODE_COLLISION)", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "33333333",
      encrypted_bundle: bundle("ALICE"),
    });
    const res = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "33333333",
      encrypted_bundle: bundle("BOB"),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CODE_COLLISION");
  });
});

describe("GET /v1/pairing/claim/:code", () => {
  it("is unauthenticated and returns the encrypted_bundle by code", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "44444444",
      encrypted_bundle: ALICE_BUNDLE,
    });
    const res = await app.inject({ method: "GET", url: "/v1/pairing/claim/44444444" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.encrypted_bundle).toBe(ALICE_BUNDLE);
    expect(body.attempts_remaining).toBe(4);
  });

  it("does NOT leak owner_public_key in the unauthenticated claim response (Codex Tier-2 #1)", async () => {
    // Anyone who can hit the public claim endpoint with a code (whether
    // they're the legitimate device B or an attacker who guessed the
    // code) must not learn the owner's long-lived Ed25519 identity key.
    // Pre-fix the response included it, letting an attacker pivot from
    // "I know a code" to "and here's the identity that posted it."
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "44444445",
      encrypted_bundle: ALICE_BUNDLE,
    });
    const res = await app.inject({ method: "GET", url: "/v1/pairing/claim/44444445" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty("owner_public_key");
    // Sanity-check: the publicKeyPem string is nowhere in the response
    // body (defends against any future field that might smuggle it).
    expect(JSON.stringify(body)).not.toContain(publicKeyPem.slice(40, 80));
  });

  it("returns 404 for an unknown code", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/pairing/claim/99999999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 429 after MAX_CLAIM_ATTEMPTS", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "55555555",
      encrypted_bundle: ALICE_BUNDLE,
    });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: "/v1/pairing/claim/55555555" });
    }
    const res = await app.inject({ method: "GET", url: "/v1/pairing/claim/55555555" });
    expect(res.statusCode).toBe(429);
  });

  it("rejects malformed codes with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/pairing/claim/abc" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/pairing/list", () => {
  it("requires auth and returns only the caller's bundles", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "60000001",
      encrypted_bundle: bundle("A1"),
    });
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "60000002",
      encrypted_bundle: bundle("A2"),
    });
    await signedInject(bob.privateKeyPem, bob.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "60000003",
      encrypted_bundle: bundle("B1"),
    });

    const aliceList = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/pairing/list");
    const aliceBundles = aliceList.json().bundles as { code: string }[];
    const aliceCodes = aliceBundles.map((b) => b.code).sort();
    expect(aliceCodes).toEqual(["60000001", "60000002"]);

    const bobList = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "GET", "/v1/pairing/list");
    const bobCodes = (bobList.json().bundles as { code: string }[]).map((b) => b.code);
    expect(bobCodes).toEqual(["60000003"]);
  });
});

describe("DELETE /v1/pairing/:code", () => {
  it("requires auth and only the owner can cancel", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/pairing/init", {
      code: "70000001",
      encrypted_bundle: bundle("ALICE_DEL"),
    });
    // Bob can't delete Alice's bundle.
    const bobAttempt = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "DELETE", "/v1/pairing/70000001");
    expect(bobAttempt.statusCode).toBe(404);
    // Bundle still there.
    const probe = await db.query("SELECT 1 FROM pairing_bundles WHERE code = $1", ["70000001"]);
    expect(probe.rows.length).toBe(1);
    // Alice can.
    const aliceDel = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "DELETE", "/v1/pairing/70000001");
    expect(aliceDel.statusCode).toBe(200);
    const probe2 = await db.query("SELECT 1 FROM pairing_bundles WHERE code = $1", ["70000001"]);
    expect(probe2.rows.length).toBe(0);
  });
});

describe("prune loop", () => {
  it("deletes rows past expires_at and rows that hit the attempt cap", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "80000001",
      encrypted_bundle: bundle("ALIVE"),
    });
    // Manually expire a bundle (pg-mem doesn't support `now() - interval` cleanly in WHERE on UPDATE,
    // but it accepts an explicit ISO string).
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.query("UPDATE pairing_bundles SET expires_at = $1 WHERE code = $2", [past, "80000001"]);

    // Insert one that hit the cap.
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/pairing/init", {
      code: "80000002",
      encrypted_bundle: bundle("CAPPED"),
    });
    await db.query("UPDATE pairing_bundles SET claim_attempts = 5 WHERE code = $1", ["80000002"]);

    const before = await db.query("SELECT COUNT(*) as c FROM pairing_bundles");
    expect(Number((before.rows[0] as { c: number | string }).c)).toBe(2);

    const deleted = await prunePairingBundles(db);
    expect(deleted).toBe(2);

    const after = await db.query("SELECT COUNT(*) as c FROM pairing_bundles");
    expect(Number((after.rows[0] as { c: number | string }).c)).toBe(0);
  });
});

describe("schema migration", () => {
  it("creates the pairing_bundles table", async () => {
    const r = await db.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pairing_bundles') AS exists"
    );
    expect(r.rows[0].exists).toBe(true);
  });
});
