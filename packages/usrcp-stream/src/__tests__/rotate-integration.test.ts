/**
 * Integration test for identity rotation.
 *
 * Lives in usrcp-stream because that's where the in-process Fastify +
 * pg-mem rig already exists. The rotation feature itself touches
 * neither stream tables nor stream code; this file just borrows the
 * harness to drive the full local + cloud round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { Db, type PoolLike } from "usrcp-cloud/dist/db.js";
import { createApp } from "usrcp-cloud/dist/server.js";
import {
  setUserSlug,
  initializeMasterKey,
  getUserDir,
  zeroBuffer,
} from "usrcp-core/encryption";
import { initializeIdentity, getDecryptedPrivateKeyPem } from "usrcp-core/crypto";
import { rotateIdentity } from "usrcp-core/rotate-identity";

const PASSPHRASE = "correct-horse-battery-staple-rotate-int";

async function makeCloud(): Promise<{
  app: FastifyInstance;
  cloudDb: Db;
  fetchImpl: typeof fetch;
}> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as PoolLike;
  const cloudDb = new Db(pool);
  await cloudDb.migrate();
  const app = createApp({ db: cloudDb, logger: false });
  await app.ready();

  const fetchImpl: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const pathWithQuery = u.pathname + (u.search || "");
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "DELETE",
      url: pathWithQuery,
      headers: (init?.headers as Record<string, string>) ?? {},
      payload: init?.body ? String(init.body) : undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as unknown as typeof fetch;

  return { app, cloudDb, fetchImpl };
}

let cloud: Awaited<ReturnType<typeof makeCloud>>;
let tmpHome: string;
let origHome: string | undefined;

beforeEach(async () => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-rotate-int-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  cloud = await makeCloud();
});

afterEach(async () => {
  try { await cloud.app.close(); } catch { /* */ }
  try { await cloud.cloudDb.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// KEEP IN SYNC with packages/usrcp-cloud/src/auth.ts.
function canonicalRequest(method: string, p: string, ts: number, nonce: string, body: string): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return Buffer.from([method.toUpperCase(), p, String(ts), nonce, bodyHash].join("\n"), "utf8");
}
function signedFetch(privateKeyPem: string, publicKeyPem: string, method: "GET" | "POST", p: string, body?: unknown) {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, p, timestampMs, nonce, bodyStr);
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(privateKeyPem));
  return cloud.app.inject({
    method,
    url: p,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(timestampMs),
      "x-usrcp-nonce": nonce,
      "x-usrcp-signature": sig.toString("base64url"),
    },
    payload: body === undefined ? undefined : bodyStr,
  });
}


// Canonical SPKI-DER identity id, matching usrcp-cloud auth.ts canonicalKeyId.
// The cloud keys its DB rows off this (#176); responses still echo PEMs.
const canonId = (pem: string): string =>
  crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");

describe("identity rotation - end-to-end", () => {
  it("rotates K1 -> K2: K1 is revoked, K2 reads K1's data", async () => {
    // Set up alice with some data.
    const masterKey = initializeMasterKey(PASSPHRASE);
    const aliceOldIdentity = initializeIdentity(masterKey);
    const oldPub = aliceOldIdentity.public_key;
    const oldPriv = getDecryptedPrivateKeyPem(masterKey);

    // Write an event and identity row signed by K1.
    const writeIdentity = await signedFetch(oldPriv, oldPub, "POST", "/v1/state", {
      identity: { display_name_enc: "enc:DISPLAY_NAME_BEFORE_ROTATION" },
    });
    expect(writeIdentity.statusCode).toBe(200);
    const writeEvent = await signedFetch(oldPriv, oldPub, "POST", "/v1/events", {
      events: [{
        event_id: "ev_before_rotation",
        client_timestamp: new Date().toISOString(),
        domain_pseudonym: "abcdef1234567890abcdef1234567890",
        summary_enc: "enc:BEFORE_ROTATION_SUMMARY_LONG",
      }],
    });
    expect(writeEvent.statusCode).toBe(200);

    // Rotate.
    const r = await rotateIdentity({
      userDir: getUserDir(),
      masterKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });
    expect(r.old_public_key).toBe(oldPub);
    expect(r.new_public_key).not.toBe(oldPub);

    // The new keypair on disk matches r.new_public_key.
    const onDiskPub = fs.readFileSync(path.join(getUserDir(), "keys", "public.pem"), "utf-8");
    expect(onDiskPub).toBe(r.new_public_key);

    // Decrypt the new private.pem from disk and use it to sign a request.
    // We have to re-derive the master key because rotateIdentity zeroed nothing in
    // our copy - but we still hold masterKey above; use it.
    const newPriv = getDecryptedPrivateKeyPem(masterKey);

    // K1-signed request is now rejected.
    const oldStateRes = await signedFetch(oldPriv, oldPub, "GET", "/v1/state");
    expect(oldStateRes.statusCode).toBe(401);
    expect(oldStateRes.json().error).toBe("KEY_REVOKED");

    // K2-signed request sees the pre-rotation event AND identity.
    const newStateRes = await signedFetch(newPriv, r.new_public_key, "GET", "/v1/state");
    expect(newStateRes.statusCode).toBe(200);
    const state = newStateRes.json();
    expect(state.events.length).toBe(1);
    expect(state.events[0].event_id).toBe("ev_before_rotation");
    expect(state.identity?.display_name_enc).toBe("enc:DISPLAY_NAME_BEFORE_ROTATION");

    // K2 can write new events under the same user.
    const writeNew = await signedFetch(newPriv, r.new_public_key, "POST", "/v1/events", {
      events: [{
        event_id: "ev_after_rotation",
        client_timestamp: new Date().toISOString(),
        domain_pseudonym: "abcdef1234567890abcdef1234567890",
        summary_enc: "enc:AFTER_ROTATION_SUMMARY_LONG",
      }],
    });
    expect(writeNew.statusCode).toBe(200);

    // The cloud's users table has exactly one row, owned by K2.
    const users = await cloud.cloudDb.query<{ public_key: string }>("SELECT public_key FROM users");
    expect(users.rows.length).toBe(1);
    expect(users.rows[0].public_key).toBe(canonId(r.new_public_key));

    // The revoked_keys table records (K1 -> K2).
    const revoked = await cloud.cloudDb.query<{ public_key: string; rotated_to: string }>(
      "SELECT public_key, rotated_to FROM revoked_keys"
    );
    expect(revoked.rows.length).toBe(1);
    expect(revoked.rows[0].public_key).toBe(canonId(oldPub));
    expect(revoked.rows[0].rotated_to).toBe(canonId(r.new_public_key));

    zeroBuffer(masterKey);
  });
});
