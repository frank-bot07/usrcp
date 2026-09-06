import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPool, type Db } from "../db.js";
import { createApp } from "../server.js";
import { signRequest } from "../auth.js";
import { makeKeyPair } from "./helpers.js";
import type { FastifyInstance } from "fastify";

// This suite must use a disposable database; CI supplies a dedicated service.
const url = process.env.USRCP_TEST_DATABASE_URL;
describe.skipIf(!url)("Postgres state concurrency", () => {
  let db: Db;
  let app: FastifyInstance;
  beforeAll(async () => { db = createPgPool(url!); await db.migrate(); app = createApp({ db, rateLimit: false }); await app.ready(); });
  afterAll(async () => { await app?.close(); await db?.close(); });
  function client() {
    const key = makeKeyPair();
    return async (method: "GET" | "POST", data?: unknown) => {
      const body = data === undefined ? "" : JSON.stringify(data);
      const s = signRequest(key.privateKeyPem, method, "/v1/state", body);
      return app.inject({ method, url: "/v1/state", headers: {
        "content-type": "application/json", "x-usrcp-publickey": Buffer.from(key.publicKeyPem).toString("base64"),
        "x-usrcp-timestamp": String(s.timestampMs), "x-usrcp-nonce": s.nonce, "x-usrcp-signature": s.signature,
      }, ...(data === undefined ? {} : { payload: body }) });
    };
  }
  it.each([0, 1])("allows exactly one writer at expected version %i", async (version) => {
    const request = client();
    if (version) expect((await request("POST", { identity: { display_name_enc: "enc:seed", expected_version: 0 } })).statusCode).toBe(200);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => request("POST", {
      identity: { display_name_enc: `enc:writer-${i}`, expected_version: version },
    })));
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(11);
    expect((await request("GET")).json().identity.version).toBe(version + 1);
  });
  it("rolls back all sections on a later database constraint failure", async () => {
    const request = client();
    const fact = (id: string, hash: string) => ({ fact_id: id, domain_pseudonym: "d_coding", ns_key_hash: hash.repeat(16), namespace_enc: "enc:n", key_enc: "enc:k", value_enc: "enc:v" });
    await request("POST", { identity: { display_name_enc: "enc:original" }, facts: [fact("a", "a"), fact("b", "b")] });
    // Move existing fact a onto b's unique namespace key after identity write.
    const response = await request("POST", { identity: { display_name_enc: "enc:must-rollback", expected_version: 1 }, facts: [fact("a", "b")] });
    expect(response.statusCode).toBe(409);
    const state = (await request("GET")).json();
    expect(state.identity.display_name_enc).toBe("enc:original");
    expect(state.identity.version).toBe(1);
    expect(state.facts).toHaveLength(2);
  });
});
