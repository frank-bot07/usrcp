import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import * as crypto from "node:crypto";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import { createApp } from "../server.js";
import { signRequest, canonicalKeyId } from "../auth.js";
import { ROTATE_ATTESTATION_DOMAIN, ROTATE_POP_DOMAIN } from "../rotate.js";
import { DEFAULT_RATE_LIMIT_CONFIG, type RateLimitConfig } from "../rate-limit.js";

// #170 (POST /v1/state atomicity) + #177 (rotation proof of possession,
// XFF rate-limit bypass, /v1/events silent drop, fact_id 500s, query
// param validation, no SQL echo in errors).

const canonId = (pem: string): string => canonicalKeyId(crypto.createPublicKey(pem));

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

const DOMAIN = "abcdef1234567890abcdef1234567890";

function eventBody(id: string, summary = `enc:SUMMARY_FOR_${id}_LONG_ENOUGH`) {
  return {
    event_id: id,
    client_timestamp: new Date().toISOString(),
    domain_pseudonym: DOMAIN,
    summary_enc: summary,
  };
}

function factBody(factId: string, nsKeyHash: string, value = "enc:FACT_VALUE_LONG_ENOUGH") {
  return {
    fact_id: factId,
    domain_pseudonym: DOMAIN,
    ns_key_hash: nsKeyHash,
    namespace_enc: "enc:NAMESPACE_LONG_ENOUGH",
    key_enc: "enc:KEY_LONG_ENOUGH",
    value_enc: value,
  };
}

describe("POST /v1/state is atomic (#170)", () => {
  it("a version conflict in a later section rolls back the earlier sections", async () => {
    const alice = makeKeyPair();
    // Seed identity at version 1.
    const seed = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:ORIGINAL_NAME_LONG_ENOUGH" },
    });
    expect(seed.statusCode).toBe(200);

    // Identity update would succeed (expected_version matches), but the
    // facts section carries a wrong expected_version. Pre-fix, the identity
    // write was already committed when the 409 went out.
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:CLOBBERED_NAME_LONG_ENOUGH", expected_version: 1 },
      facts: [{ ...factBody("f-atomic", "a".repeat(32)), expected_version: 99 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("VERSION_CONFLICT");
    expect(res.json().scope).toBe("schemaless_facts");

    // NOTHING committed: identity kept its original name AND version.
    const state = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(state.statusCode).toBe(200);
    expect(state.json().identity.display_name_enc).toBe("enc:ORIGINAL_NAME_LONG_ENOUGH");
    expect(Number(state.json().identity.version)).toBe(1);
    // And the fact was not created either.
    const facts = await db.query("SELECT 1 FROM schemaless_facts WHERE fact_id = 'f-atomic'");
    expect(facts.rows.length).toBe(0);
  });
});

describe("rotation requires proof of possession of the new key (#177)", () => {
  function attestRotation(oldPrivateKeyPem: string, newPublicKeyPem: string): string {
    const canon = Buffer.from(`${ROTATE_ATTESTATION_DOMAIN}\n${newPublicKeyPem}`, "utf8");
    return crypto.sign(null, canon, crypto.createPrivateKey(oldPrivateKeyPem)).toString("base64url");
  }
  function attestPop(newPrivateKeyPem: string, oldPublicKeyPem: string): string {
    const canon = Buffer.from(`${ROTATE_POP_DOMAIN}\n${oldPublicKeyPem}`, "utf8");
    return crypto.sign(null, canon, crypto.createPrivateKey(newPrivateKeyPem)).toString("base64url");
  }

  it("rejects a rotation without new_key_attestation and leaves the old key alive", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:ALICE_NAME_LONG_ENOUGH" },
    });

    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_BODY");

    const alive = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(alive.statusCode).toBe(200);
  });

  it("rejects a PoP not signed by the new key: a typo'd new_public_key cannot brick the account", async () => {
    const alice = makeKeyPair();
    const aliceNew = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:ALICE_NAME_LONG_ENOUGH" },
    });

    // The old key signs BOTH attestations: exactly the pre-fix reachable
    // state where new_public_key is a key nobody holds the private half of.
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/rotate-identity", {
      new_public_key: aliceNew.publicKeyPem,
      rotation_attestation: attestRotation(alice.privateKeyPem, aliceNew.publicKeyPem),
      new_key_attestation: attestPop(alice.privateKeyPem, alice.publicKeyPem),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("BAD_NEW_KEY_ATTESTATION");

    // Old key still alive, nothing revoked, no data moved.
    const alive = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(alive.statusCode).toBe(200);
    const users = await db.query<{ public_key: string }>("SELECT public_key FROM users");
    expect(users.rows.map((r) => r.public_key)).toEqual([canonId(alice.publicKeyPem)]);
    const revoked = await db.query("SELECT 1 FROM revoked_keys");
    expect(revoked.rows.length).toBe(0);
  });
});

describe("POST /v1/events reports duplicates truthfully (#177)", () => {
  it("re-pushing an existing event_id returns the stored sequence with duplicate:true and leaves content untouched", async () => {
    const alice = makeKeyPair();
    const first = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [eventBody("e1"), eventBody("e2")],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toEqual([
      { event_id: "e1", ledger_sequence: 1, duplicate: false },
      { event_id: "e2", ledger_sequence: 2, duplicate: false },
    ]);

    // Re-push e1 with DIFFERENT ciphertext. Pre-fix: fresh fabricated
    // sequence, duplicate:false, new content silently discarded, and a
    // permanent gap in the sequence numbering.
    const repush = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [eventBody("e1", "enc:DIVERGENT_CONTENT_LONG_ENOUGH")],
    });
    expect(repush.statusCode).toBe(200);
    expect(repush.json().accepted).toEqual([
      { event_id: "e1", ledger_sequence: 1, duplicate: true },
    ]);

    // Stored content is the original; no phantom row, no sequence gap.
    const stored = await db.query<{ summary_enc: string; ledger_sequence: number }>(
      "SELECT summary_enc, ledger_sequence FROM timeline_events WHERE event_id = 'e1'"
    );
    expect(stored.rows.length).toBe(1);
    expect(stored.rows[0].summary_enc).toBe("enc:SUMMARY_FOR_e1_LONG_ENOUGH");

    const next = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [eventBody("e3")],
    });
    expect(next.json().accepted).toEqual([
      { event_id: "e3", ledger_sequence: 3, duplicate: false },
    ]);
  });

  it("a repeated event_id within one batch stores one row and reports the repeat as duplicate", async () => {
    const alice = makeKeyPair();
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [eventBody("e-batch"), eventBody("e-batch", "enc:SECOND_COPY_LONG_ENOUGH")],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toEqual([
      { event_id: "e-batch", ledger_sequence: 1, duplicate: false },
      { event_id: "e-batch", ledger_sequence: 1, duplicate: true },
    ]);
    const rows = await db.query("SELECT 1 FROM timeline_events WHERE event_id = 'e-batch'");
    expect(rows.rows.length).toBe(1);
  });
});

describe("facts keyed by fact_id do not 500 (#177)", () => {
  it("reusing a fact_id under a new ns_key_hash updates the row instead of hitting the PK", async () => {
    const alice = makeKeyPair();
    const nsA = "a".repeat(32);
    const nsB = "b".repeat(32);
    const seed = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      facts: [factBody("f1", nsA)],
    });
    expect(seed.statusCode).toBe(200);

    // Same fact_id, new ns_key_hash. Pre-fix: classified as an insert by
    // ns-key, collided with PK (user, fact_id), raw 23505 turned into a 500
    // that echoed the SQL statement.
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      facts: [factBody("f1", nsB, "enc:MOVED_VALUE_LONG_ENOUGH")],
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.query<{ ns_key_hash: string; value_enc: string; version: number }>(
      "SELECT ns_key_hash, value_enc, version FROM schemaless_facts WHERE fact_id = 'f1'"
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].ns_key_hash).toBe(nsB);
    expect(rows.rows[0].value_enc).toBe("enc:MOVED_VALUE_LONG_ENOUGH");
    expect(Number(rows.rows[0].version)).toBe(2);
  });

  it("two facts sharing a fact_id in one batch fold to one write instead of a 500", async () => {
    const alice = makeKeyPair();
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      facts: [
        factBody("f-dup", "c".repeat(32), "enc:FIRST_VALUE_LONG_ENOUGH"),
        factBody("f-dup", "d".repeat(32), "enc:SECOND_VALUE_LONG_ENOUGH"),
      ],
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.query<{ ns_key_hash: string; value_enc: string }>(
      "SELECT ns_key_hash, value_enc FROM schemaless_facts WHERE fact_id = 'f-dup'"
    );
    expect(rows.rows.length).toBe(1);
    // Last write wins.
    expect(rows.rows[0].ns_key_hash).toBe("d".repeat(32));
    expect(rows.rows[0].value_enc).toBe("enc:SECOND_VALUE_LONG_ENOUGH");
  });

  it("a residual constraint conflict returns a generic 409 with no SQL text", async () => {
    const alice = makeKeyPair();
    const nsA = "e".repeat(32);
    const nsB = "f".repeat(32);
    // Two rows, then move f2 onto f1's ns-key via its fact_id: the UPDATE
    // collides with UNIQUE (user, domain, ns_key_hash).
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      facts: [factBody("fa", nsA), factBody("fb", nsB)],
    });
    const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/state", {
      facts: [factBody("fb", nsA)],
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.stringify(res.json());
    expect(res.json().error).toBe("CONFLICT");
    for (const fragment of ["INSERT INTO", "UPDATE ", "SELECT ", "schemaless_facts"]) {
      expect(body).not.toContain(fragment);
    }
  });
});

describe("query params are validated (#177)", () => {
  it("limit=0, limit=-1, limit=1.5 and since=1.5 never 500 and cannot spin a paging client", async () => {
    const alice = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [eventBody("e-page")],
    });

    for (const qs of ["limit=0", "limit=-1", "limit=1.5", "since=1.5", "since=-3", "limit=abc"]) {
      const res = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", `/v1/state?${qs}`);
      expect(res.statusCode).toBe(200);
    }

    // limit=0 is floored to 1: the page returns a row and the cursor
    // advances, so a client looping on has_more makes progress.
    const floored = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state?limit=0");
    expect(floored.json().events.length).toBe(1);
    expect(Number(floored.json().cursor)).toBe(1);

    // Same clamp on the stream pull endpoint.
    const stream = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/stream/pull?limit=0");
    expect(stream.statusCode).toBe(200);
  });
});

describe("XFF spoofing cannot bypass per-IP limits (#177)", () => {
  function makeAppWithLimit(limit: Partial<RateLimitConfig>): FastifyInstance {
    const config: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...limit };
    return createApp({ db, logger: false, rateLimit: config });
  }

  it("rotating the client-controlled leftmost XFF entry stays in one bucket", async () => {
    const limited = makeAppWithLimit({ pairingClaimRpm: 3, trustProxy: true, trustProxyHops: 1 });
    await limited.ready();

    // The trusted proxy APPENDS the real client ip (9.9.9.9) as the LAST
    // entry; the attacker rotates the leftmost. Pre-fix the leftmost was
    // trusted, so every request landed in a fresh bucket: 0/50 blocked in
    // the live repro. Now all four attribute to 9.9.9.9.
    for (let i = 0; i < 3; i++) {
      const res = await limited.inject({
        method: "GET",
        url: `/v1/pairing/claim/1000000${i}`,
        headers: { "x-forwarded-for": `1.2.3.${i}, 9.9.9.9` },
        remoteAddress: "9.9.9.9",
      });
      expect(res.statusCode).toBe(404);
    }
    const blocked = await limited.inject({
      method: "GET",
      url: "/v1/pairing/claim/10000009",
      headers: { "x-forwarded-for": "1.2.3.99, 9.9.9.9" },
      remoteAddress: "9.9.9.9",
    });
    expect(blocked.statusCode).toBe(429);
    await limited.close();
  });
});
