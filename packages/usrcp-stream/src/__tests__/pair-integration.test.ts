/**
 * Integration test for multi-device pairing.
 *
 * Lives in usrcp-stream because that's the only package that depends on both
 * usrcp-local (for pairInit/pairJoin) AND usrcp-cloud + pg-mem (for the
 * in-process Fastify rig). The pairing flow itself touches neither stream
 * tables nor stream code - this file just borrows the integration harness.
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
} from "usrcp-local/dist/encryption.js";
import { initializeIdentity, getDecryptedPrivateKeyPem } from "usrcp-local/dist/crypto.js";
import { pairInit, pairJoin, pairStatus, pairCancel } from "usrcp-local/dist/pair.js";

const PASSPHRASE = "correct-horse-battery-staple-pair-int";

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
let homeRoot: string;
let aliceHome: string;
let bobHome: string;
let origHome: string | undefined;

beforeEach(async () => {
  origHome = process.env.HOME;
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-int-"));
  aliceHome = fs.mkdtempSync(path.join(homeRoot, "alice-"));
  bobHome = fs.mkdtempSync(path.join(homeRoot, "bob-"));
  cloud = await makeCloud();
});

afterEach(async () => {
  try { await cloud.app.close(); } catch { /* */ }
  try { await cloud.cloudDb.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

function setupAliceIdentity(): { publicKey: string; privateKey: string; userId: string } {
  process.env.HOME = aliceHome;
  setUserSlug("default");
  const masterKey = initializeMasterKey(PASSPHRASE);
  const identity = initializeIdentity(masterKey);
  const publicKey = identity.public_key;
  const privateKey = getDecryptedPrivateKeyPem(masterKey);
  zeroBuffer(masterKey);
  return { publicKey, privateKey, userId: identity.user_id };
}

describe("multi-device pairing - end-to-end", () => {
  it("A pairInit -> B pairJoin yields a byte-identical identity on B", async () => {
    const alice = setupAliceIdentity();
    const aliceUserDir = getUserDir();

    const initResult = await pairInit({
      userDir: aliceUserDir,
      publicKeyPem: alice.publicKey,
      privateKeyPem: alice.privateKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });
    const { code, pairingString } = initResult;
    expect(/^[0-9]{8}$/.test(code)).toBe(true);
    expect(pairingString.replace(/-/g, "").length).toBe(40); // 8 digits + 32 hex

    // No-plaintext-on-server check: the stored bundle ciphertext does NOT
    // contain alice's user_id or PEM substrings as plaintext.
    const stored = await cloud.cloudDb.query<{ encrypted_bundle: string }>(
      "SELECT encrypted_bundle FROM pairing_bundles WHERE code = $1",
      [code]
    );
    const bundle = stored.rows[0].encrypted_bundle;
    expect(bundle.includes(alice.userId)).toBe(false);
    expect(bundle.includes("BEGIN PRIVATE KEY")).toBe(false);
    expect(bundle.includes("BEGIN PUBLIC KEY")).toBe(false);
    expect(bundle.startsWith("enc:")).toBe(true);

    // v2 invariant: the 16-byte secret half of the pairing string MUST
    // NOT appear in any column of the pairing_bundles row. The cloud
    // sees the lookup code and the ciphertext only.
    const secretHex = pairingString.replace(/-/g, "").slice(8);
    expect(secretHex.length).toBe(32);
    const allRow = await cloud.cloudDb.query<{ code: string; encrypted_bundle: string; owner_public_key: string }>(
      "SELECT code, encrypted_bundle, owner_public_key FROM pairing_bundles WHERE code = $1",
      [code]
    );
    for (const col of [allRow.rows[0].code, allRow.rows[0].encrypted_bundle, allRow.rows[0].owner_public_key]) {
      expect(col.toLowerCase().includes(secretHex.toLowerCase())).toBe(false);
    }

    process.env.HOME = bobHome;
    setUserSlug("default");
    const bobUserDir = getUserDir();
    const r = await pairJoin(pairingString, {
      userDir: bobUserDir,
      passphrase: PASSPHRASE,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });
    expect(r.user_id).toBe(alice.userId);
    expect(r.public_key).toBe(alice.publicKey);

    // identity.json must match byte-for-byte after re-parse (it's pretty-printed
    // on both sides via JSON.stringify(...,null,2)).
    const aIdentityRaw = fs.readFileSync(path.join(aliceUserDir, "keys", "identity.json"));
    const bIdentityRaw = fs.readFileSync(path.join(bobUserDir, "keys", "identity.json"));
    expect(bIdentityRaw.equals(aIdentityRaw)).toBe(true);

    // master.salt + master.verify byte equality.
    expect(
      fs.readFileSync(path.join(aliceUserDir, "keys", "master.salt"))
        .equals(fs.readFileSync(path.join(bobUserDir, "keys", "master.salt")))
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(aliceUserDir, "keys", "master.verify"))
        .equals(fs.readFileSync(path.join(bobUserDir, "keys", "master.verify")))
    ).toBe(true);

    // Bob signs a request that the cloud accepts under the SAME user_public_key.
    // We hit /v1/state - it's the simplest authenticated GET and proves bob's
    // signed request reads alice's user row.
    const bobMaster = initializeMasterKey(PASSPHRASE);
    const bobPrivate = getDecryptedPrivateKeyPem(bobMaster);
    zeroBuffer(bobMaster);

    const { timestampMs, nonce, signature } = signAdHoc(
      bobPrivate, "GET", "/v1/state"
    );
    const stateRes = await cloud.app.inject({
      method: "GET",
      url: "/v1/state",
      headers: {
        "x-usrcp-publickey": Buffer.from(alice.publicKey).toString("base64"),
        "x-usrcp-timestamp": String(timestampMs),
        "x-usrcp-nonce": nonce,
        "x-usrcp-signature": signature,
      },
    });
    expect(stateRes.statusCode).toBe(200);

    // pairing_bundles row still has the same owner_public_key as alice.
    const owner = await cloud.cloudDb.query<{ owner_public_key: string }>(
      "SELECT owner_public_key FROM pairing_bundles WHERE code = $1",
      [code]
    );
    expect(owner.rows[0]?.owner_public_key).toBe(alice.publicKey);
  });

  it("wrong-passphrase pairJoin leaves bob's keys/ dir untouched", async () => {
    const alice = setupAliceIdentity();
    const { pairingString } = await pairInit({
      userDir: getUserDir(),
      publicKeyPem: alice.publicKey,
      privateKeyPem: alice.privateKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });

    process.env.HOME = bobHome;
    setUserSlug("default");
    const bobUserDir = getUserDir();
    await expect(
      pairJoin(pairingString, {
        userDir: bobUserDir,
        passphrase: "wrong-passphrase",
        endpoint: "http://stub",
        fetchImpl: cloud.fetchImpl,
      })
    ).rejects.toThrow(/passphrase/i);

    const bobKeysDir = path.join(bobUserDir, "keys");
    const remaining = fs.existsSync(bobKeysDir) ? fs.readdirSync(bobKeysDir) : [];
    expect(remaining).toEqual([]);
  });

  it("pairStatus then pairCancel removes the row server-side", async () => {
    const alice = setupAliceIdentity();
    const { code } = await pairInit({
      userDir: getUserDir(),
      publicKeyPem: alice.publicKey,
      privateKeyPem: alice.privateKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });

    const list = await pairStatus({
      publicKeyPem: alice.publicKey,
      privateKeyPem: alice.privateKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });
    expect(list.length).toBe(1);
    expect(list[0].code).toBe(code);

    await pairCancel(code, {
      publicKeyPem: alice.publicKey,
      privateKeyPem: alice.privateKey,
      endpoint: "http://stub",
      fetchImpl: cloud.fetchImpl,
    });

    const after = await cloud.cloudDb.query("SELECT 1 FROM pairing_bundles WHERE code = $1", [code]);
    expect(after.rows.length).toBe(0);
  });
});

// --- helpers ---

// Mirror of pair.ts signRequest, kept local so the test file is self-contained.
function signAdHoc(
  privateKeyPem: string,
  method: string,
  pathWithQuery: string
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const canon = Buffer.from(
    [method.toUpperCase(), pathWithQuery, String(timestampMs), nonce, bodyHash].join("\n"),
    "utf8"
  );
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(privateKeyPem));
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}
