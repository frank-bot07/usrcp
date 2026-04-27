import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import { createApp } from "../server.js";
import { signRequest } from "../auth.js";

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
  method: "GET" | "POST",
  url: string,
  bodyObj?: unknown
): Promise<ReturnType<FastifyInstance["inject"]>> {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const signed = signRequest(privateKeyPem, method, url, body);
  const injectOpts: any = {
    method,
    url,
    headers: {
      "content-type": "application/json",
      // PEM contains newlines — not valid in HTTP headers. Wire format
      // is base64-encoded PEM; server decodes before parsing.
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
  };
  if (bodyObj !== undefined) injectOpts.payload = body;
  return app.inject(injectOpts);
}

describe("healthz", () => {
  it("is unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/events", () => {
  it("rejects unsigned requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ events: [] }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("MISSING_AUTH_HEADERS");
  });

  it("accepts a signed append and assigns ledger_sequence=1", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [
        {
          event_id: "01HPX00000000000000000001A",
          client_timestamp: "2026-04-20T00:00:00.000Z",
          domain_pseudonym: "d_abc123",
          summary_enc: "enc:ciphertext1",
          intent_enc: "enc:intent1",
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0].ledger_sequence).toBe(1);
    expect(body.accepted[0].duplicate).toBe(false);
    expect(body.cursor).toBe(1);
  });

  it("monotonically increments ledger_sequence across multiple appends", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    for (let i = 1; i <= 3; i++) {
      const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
        events: [
          {
            event_id: `01HPX0000000000000000000${i}A`,
            client_timestamp: "2026-04-20T00:00:00.000Z",
            domain_pseudonym: "d_abc",
            summary_enc: `enc:msg${i}`,
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted[0].ledger_sequence).toBe(i);
    }
  });

  it("honors idempotency_key — duplicate returns existing ledger_sequence", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const first = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [
        {
          event_id: "01HPX000000000000000000001",
          client_timestamp: "2026-04-20T00:00:00.000Z",
          domain_pseudonym: "d_xxx",
          summary_enc: "enc:a",
          idempotency_key: "idemp-1",
        },
      ],
    });
    expect(first.statusCode).toBe(200);
    const firstSeq = first.json().accepted[0].ledger_sequence;

    // Same idempotency_key, different event_id — server returns the original
    const second = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [
        {
          event_id: "01HPX000000000000000000002",
          client_timestamp: "2026-04-20T00:00:00.000Z",
          domain_pseudonym: "d_xxx",
          summary_enc: "enc:b",
          idempotency_key: "idemp-1",
        },
      ],
    });
    expect(second.statusCode).toBe(200);
    const dup = second.json().accepted[0];
    expect(dup.duplicate).toBe(true);
    expect(dup.ledger_sequence).toBe(firstSeq);
    expect(dup.event_id).toBe("01HPX000000000000000000001");
  });

  it("rejects oversized summary_enc", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [
        {
          event_id: "01HPX000000000000000000001",
          client_timestamp: "2026-04-20T00:00:00.000Z",
          domain_pseudonym: "d_xxx",
          summary_enc: "x".repeat(8193),
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_BODY");
  });
});

describe("GET /v1/state", () => {
  it("returns only events for the authenticated user", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();

    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/events", {
      events: [
        { event_id: "e-alice", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_a", summary_enc: "enc:alice1" },
      ],
    });
    await signedInject(bob.privateKeyPem, bob.publicKeyPem, "POST", "/v1/events", {
      events: [
        { event_id: "e-bob", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_b", summary_enc: "enc:bob1" },
      ],
    });

    const aliceView = await signedInject(alice.privateKeyPem, alice.publicKeyPem, "GET", "/v1/state");
    expect(aliceView.statusCode).toBe(200);
    const aliceBody = aliceView.json();
    expect(aliceBody.events).toHaveLength(1);
    expect(aliceBody.events[0].event_id).toBe("e-alice");

    const bobView = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "GET", "/v1/state");
    expect(bobView.statusCode).toBe(200);
    expect(bobView.json().events).toHaveLength(1);
    expect(bobView.json().events[0].event_id).toBe("e-bob");
  });

  it("respects the since cursor", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    for (let i = 1; i <= 3; i++) {
      await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
        events: [
          { event_id: `e${i}`, client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: `enc:${i}` },
        ],
      });
    }

    const since2 = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state?since=2");
    expect(since2.statusCode).toBe(200);
    const body = since2.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].ledger_sequence).toBe(3);
    expect(body.cursor).toBe(3);
  });

  it("cursor stays 0 when no events exist", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const res = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state");
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().cursor)).toBe(0);
  });
});

describe("POST /v1/state", () => {
  it("upserts core_identity with version tracking", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const first = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:frank" },
    });
    expect(first.statusCode).toBe(200);

    const view = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state");
    expect(view.json().identity.display_name_enc).toBe("enc:frank");
    expect(Number(view.json().identity.version)).toBe(1);

    const second = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:frank_v2" },
    });
    expect(second.statusCode).toBe(200);

    const view2 = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state");
    expect(Number(view2.json().identity.version)).toBe(2);
  });

  it("VERSION_CONFLICT when expected_version mismatches", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:v1" },
    });
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:v2", expected_version: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("VERSION_CONFLICT");
    expect(res.json().current_version).toBe(1);
  });

  it("upserts schemaless_facts with (domain, ns_key_hash) uniqueness", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const hash = "0".repeat(64); // realistic SHA-256 hex length
    const first = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      facts: [
        {
          fact_id: "f1",
          domain_pseudonym: "d_personal",
          ns_key_hash: hash,
          namespace_enc: "enc:ns",
          key_enc: "enc:k",
          value_enc: "enc:v1",
        },
      ],
    });
    expect(first.statusCode).toBe(200);
    // Second write with same (domain, ns_key_hash) must replace, not duplicate
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/state", {
      facts: [
        {
          fact_id: "f1",
          domain_pseudonym: "d_personal",
          ns_key_hash: hash,
          namespace_enc: "enc:ns",
          key_enc: "enc:k",
          value_enc: "enc:v2",
        },
      ],
    });

    const view = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state");
    expect(view.json().facts).toHaveLength(1);
    expect(view.json().facts[0].value_enc).toBe("enc:v2");
    expect(Number(view.json().facts[0].version)).toBe(2);
  });
});

describe("ledger_sequence race prevention", () => {
  it("UNIQUE index rejects a direct duplicate (user_public_key, ledger_sequence) insert", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    // Push one event to create the user record and assign sequence=1
    const r = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [{ event_id: "e1", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:a" }],
    });
    expect(r.statusCode).toBe(200);

    // Find the stored public key
    const userRow = await db.query<{ public_key: string }>("SELECT public_key FROM users LIMIT 1");
    const userKey = userRow.rows[0].public_key;

    // A direct duplicate insert at sequence=1 must fail with a UNIQUE violation
    await expect(
      db.query(
        `INSERT INTO timeline_events
           (user_public_key, event_id, ledger_sequence, client_timestamp, domain_pseudonym, summary_enc)
         VALUES ($1, 'e_dup', 1, '2026-04-20T00:00:00Z', 'd_x', 'enc:dup')`,
        [userKey]
      )
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("two concurrent pushes produce 5 distinct contiguous ledger sequences", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const [r1, r2] = await Promise.all([
      signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
        events: [
          { event_id: "e1", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:1" },
          { event_id: "e2", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:2" },
          { event_id: "e3", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:3" },
        ],
      }),
      signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
        events: [
          { event_id: "e4", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:4" },
          { event_id: "e5", client_timestamp: "2026-04-20T00:00:00Z", domain_pseudonym: "d_x", summary_enc: "enc:5" },
        ],
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await db.query<{ ledger_sequence: number }>(
      "SELECT ledger_sequence FROM timeline_events ORDER BY ledger_sequence"
    );
    expect(rows.rows).toHaveLength(5);
    const seqs = rows.rows.map((r) => Number(r.ledger_sequence));
    expect(new Set(seqs).size).toBe(5);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("ciphertext-only invariant", () => {
  it("server never stores or returns anything that could be plaintext user data", async () => {
    // Every encrypted column stored must arrive as ciphertext. The server
    // doesn't know the encryption scheme — it just persists whatever string
    // the client sent. This test documents the invariant: the value comes
    // out byte-identical to what went in, with no mutation.
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const ciphertext = "enc:AAAABBBBCCCCDDDD";
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/events", {
      events: [
        {
          event_id: "e1",
          client_timestamp: "2026-04-20T00:00:00Z",
          domain_pseudonym: "d_abc",
          summary_enc: ciphertext,
          detail_enc: ciphertext,
        },
      ],
    });

    // Raw SQL fetch — the server must not have interpreted the ciphertext
    const raw = await db.query<{ summary_enc: string; detail_enc: string }>(
      "SELECT summary_enc, detail_enc FROM timeline_events WHERE event_id = 'e1'"
    );
    expect(raw.rows[0].summary_enc).toBe(ciphertext);
    expect(raw.rows[0].detail_enc).toBe(ciphertext);

    // And GET /v1/state returns the same bytes
    const view = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/state");
    expect(view.json().events[0].summary_enc).toBe(ciphertext);
    expect(view.json().events[0].detail_enc).toBe(ciphertext);
  });
});
