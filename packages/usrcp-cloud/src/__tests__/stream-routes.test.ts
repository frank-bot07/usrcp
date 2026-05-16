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

function sampleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    client_timestamp: "2026-05-15T17:00:00.000Z",
    surface: "discord",
    side: "inbound",
    content_kind: "text",
    ts_ms: 1_700_000_000_000,
    channel_ref_enc: "enc:channel-ref",
    author_ref_enc: "enc:author",
    content_enc: "enc:content",
    entity_refs_enc: null,
    ingested_at: 1_700_000_000_010,
    idempotency_key: null,
    embedding: null,
    ...overrides,
  };
}

describe("POST /v1/stream/push", () => {
  it("rejects unsigned requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/stream/push",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ events: [sampleEvent()] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a signed push and assigns server_seq=1 for the first event", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const ev = sampleEvent({ event_id: "evt-1", idempotency_key: "k-1" });
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [ev],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0].duplicate).toBe(false);
    expect(body.accepted[0].server_seq).toBe(1);
    expect(body.cursor).toBe(1);
  });

  it("is idempotent on duplicate event_id (ON CONFLICT DO NOTHING)", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const ev = sampleEvent({ event_id: "evt-dup", idempotency_key: null });
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", { events: [ev] });
    const res2 = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [ev],
    });
    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    // Second push: same event_id, no idempotency_key -> ON CONFLICT DO
    // NOTHING means RETURNING returns zero rows; `accepted` is empty.
    expect(body.accepted).toEqual([]);
  });

  it("dedupes via idempotency_key without re-inserting", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const ev1 = sampleEvent({ event_id: "evt-a", idempotency_key: "shared-key" });
    const ev2 = sampleEvent({ event_id: "evt-b", idempotency_key: "shared-key" });
    const res1 = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [ev1],
    });
    expect(res1.json().accepted[0].server_seq).toBe(1);
    const res2 = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [ev2],
    });
    expect(res2.statusCode).toBe(200);
    const body = res2.json();
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0]).toMatchObject({
      event_id: "evt-a",
      server_seq: 1,
      duplicate: true,
    });
  });

  it("persists embedding payload alongside the event", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const ev = sampleEvent({
      event_id: "evt-emb",
      embedding: {
        vec_enc: "enc:vector-blob",
        dims: 768,
        model_enc: "enc:model-name",
      },
    });
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [ev],
    });
    expect(res.statusCode).toBe(200);
    const row = await db.query<{ embedding_present: boolean }>(
      "SELECT embedding_present FROM stream_events WHERE event_id = $1",
      ["evt-emb"]
    );
    expect(row.rows[0]?.embedding_present).toBe(true);
    const emb = await db.query<{ vec_enc: string; dims: number; model_enc: string | null }>(
      "SELECT vec_enc, dims, model_enc FROM stream_embeddings WHERE event_id = $1",
      ["evt-emb"]
    );
    expect(emb.rows[0]).toMatchObject({
      vec_enc: "enc:vector-blob",
      dims: 768,
      model_enc: "enc:model-name",
    });
  });

  it("rejects malformed bodies with 400 BAD_BODY", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const res = await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [{ event_id: "missing-required-fields" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_BODY");
  });
});

describe("GET /v1/stream/pull", () => {
  it("returns events with server_seq > since, in monotonic order", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    // Seed 3 events.
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [
        sampleEvent({ event_id: "a" }),
        sampleEvent({ event_id: "b" }),
        sampleEvent({ event_id: "c" }),
      ],
    });

    const pull1 = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/stream/pull?since=0");
    expect(pull1.statusCode).toBe(200);
    const body1 = pull1.json();
    expect(body1.events).toHaveLength(3);
    expect(body1.events.map((e: { server_seq: number }) => e.server_seq)).toEqual([1, 2, 3]);
    expect(body1.cursor).toBe(3);

    const pull2 = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/stream/pull?since=2");
    const body2 = pull2.json();
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0].event_id).toBe("c");
    expect(body2.cursor).toBe(3);
  });

  it("preserves embedding payload verbatim across push/pull", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    await signedInject(privateKeyPem, publicKeyPem, "POST", "/v1/stream/push", {
      events: [
        sampleEvent({
          event_id: "with-emb",
          embedding: { vec_enc: "enc:OPAQUE_VEC", dims: 64, model_enc: "enc:fake" },
        }),
        sampleEvent({ event_id: "no-emb" }),
      ],
    });

    const res = await signedInject(privateKeyPem, publicKeyPem, "GET", "/v1/stream/pull?since=0");
    const body = res.json();
    const withEmb = body.events.find((e: { event_id: string }) => e.event_id === "with-emb");
    const noEmb = body.events.find((e: { event_id: string }) => e.event_id === "no-emb");
    expect(withEmb.embedding).toMatchObject({
      vec_enc: "enc:OPAQUE_VEC",
      dims: 64,
      model_enc: "enc:fake",
    });
    expect(noEmb.embedding).toBeNull();
  });

  it("does not leak events from a different user_public_key", async () => {
    const alice = makeKeyPair();
    const bob = makeKeyPair();
    await signedInject(alice.privateKeyPem, alice.publicKeyPem, "POST", "/v1/stream/push", {
      events: [sampleEvent({ event_id: "alice-event" })],
    });
    const res = await signedInject(bob.privateKeyPem, bob.publicKeyPem, "GET", "/v1/stream/pull?since=0");
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });
});

describe("schema migration", () => {
  it("creates stream_events and stream_embeddings tables", async () => {
    const events = await db.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stream_events') AS exists"
    );
    const embeddings = await db.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stream_embeddings') AS exists"
    );
    expect(events.rows[0].exists).toBe(true);
    expect(embeddings.rows[0].exists).toBe(true);
  });
});
