import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import {
  signRequest,
  verifyAndClaim,
  canonicalRequest,
  AuthError,
  TIMESTAMP_WINDOW_MS,
  pruneOldNonces,
} from "../auth.js";

let db: Db;

beforeEach(async () => {
  const env = makeMemDb();
  db = env.db;
  await db.migrate();
});

afterEach(async () => {
  await db.close();
});

function headersFrom(
  pub: string,
  signed: { timestampMs: number; nonce: string; signature: string }
): Record<string, string> {
  return {
    // PEM contains newlines — not valid in HTTP headers. Wire format
    // is base64-encoded PEM; server decodes before parsing.
    "x-usrcp-publickey": Buffer.from(pub).toString("base64"),
    "x-usrcp-timestamp": String(signed.timestampMs),
    "x-usrcp-nonce": signed.nonce,
    "x-usrcp-signature": signed.signature,
  };
}

describe("canonicalRequest", () => {
  it("is deterministic given same inputs", () => {
    const a = canonicalRequest("POST", "/v1/events", 1000, "abc", "{}");
    const b = canonicalRequest("POST", "/v1/events", 1000, "abc", "{}");
    expect(a.toString()).toBe(b.toString());
  });

  it("is case-normalized on method", () => {
    const upper = canonicalRequest("POST", "/x", 1, "n", "");
    const lower = canonicalRequest("post", "/x", 1, "n", "");
    expect(upper.toString()).toBe(lower.toString());
  });

  it("changes when body changes", () => {
    const a = canonicalRequest("POST", "/x", 1, "n", "{\"a\":1}");
    const b = canonicalRequest("POST", "/x", 1, "n", "{\"a\":2}");
    expect(a.toString()).not.toBe(b.toString());
  });
});

describe("signRequest / verifyAndClaim", () => {
  it("accepts a valid signed request", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}");
    const res = await verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{}");
    expect(res.userPublicKey).toBe(publicKeyPem);
  });

  it("rejects when signature does not match body", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}");
    await expect(
      verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{\"tampered\":1}")
    ).rejects.toThrow(AuthError);
  });

  async function expectAuthCode(p: Promise<unknown>, code: string): Promise<void> {
    try {
      await p;
      throw new Error("expected AuthError, got resolution");
    } catch (err: any) {
      if (!(err instanceof AuthError)) throw err;
      expect(err.code).toBe(code);
    }
  }

  it("rejects when signed under a different key", async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair();
    const signed = signRequest(kp1.privateKeyPem, "POST", "/v1/events", "{}");
    await expectAuthCode(
      verifyAndClaim(db, headersFrom(kp2.publicKeyPem, signed), "POST", "/v1/events", "{}"),
      "BAD_SIGNATURE"
    );
  });

  it("rejects stale timestamps outside the window", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const staleTs = Date.now() - TIMESTAMP_WINDOW_MS - 60_000;
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}", { timestampMs: staleTs });
    await expectAuthCode(
      verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{}"),
      "STALE_REQUEST"
    );
  });

  it("rejects replay with same nonce", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}", { nonce: "deadbeef" });
    await verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{}");
    await expectAuthCode(
      verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{}"),
      "REPLAY_DETECTED"
    );
  });

  it("rejects non-Ed25519 public keys", async () => {
    const { publicKey } = (await import("node:crypto")).generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const headers = {
      "x-usrcp-publickey": Buffer.from(publicKey as string).toString("base64"),
      "x-usrcp-timestamp": String(Date.now()),
      "x-usrcp-nonce": "abc12345",
      "x-usrcp-signature": Buffer.from("x").toString("base64url"),
    };
    await expectAuthCode(
      verifyAndClaim(db, headers, "POST", "/v1/events", "{}"),
      "BAD_PUBLIC_KEY"
    );
  });

  it("rejects when any required header is missing", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}");
    const h = headersFrom(publicKeyPem, signed);
    delete h["x-usrcp-signature"];
    await expectAuthCode(
      verifyAndClaim(db, h, "POST", "/v1/events", "{}"),
      "MISSING_AUTH_HEADERS"
    );
  });

  it("registers a new user on first successful request", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const signed = signRequest(privateKeyPem, "POST", "/v1/events", "{}");
    await verifyAndClaim(db, headersFrom(publicKeyPem, signed), "POST", "/v1/events", "{}");
    const users = await db.query<{ public_key: string }>("SELECT public_key FROM users");
    expect(users.rows.length).toBe(1);
    expect(users.rows[0].public_key).toBe(publicKeyPem);
  });
});

describe("pruneOldNonces", () => {
  it("deletes nonces older than 2x window, keeps recent ones", async () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    // Insert a nonce manually (no user req — just a synthetic row)
    await db.query(
      "INSERT INTO users (public_key) VALUES ($1)",
      [publicKeyPem]
    );
    // Very old: 3x window in the past
    await db.query(
      "INSERT INTO seen_nonces (user_public_key, nonce, seen_at) VALUES ($1, 'stale', $2)",
      [publicKeyPem, new Date(Date.now() - TIMESTAMP_WINDOW_MS * 3).toISOString()]
    );
    // Recent: now
    await db.query(
      "INSERT INTO seen_nonces (user_public_key, nonce, seen_at) VALUES ($1, 'fresh', now())",
      [publicKeyPem]
    );

    const pruned = await pruneOldNonces(db);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const remaining = await db.query<{ nonce: string }>("SELECT nonce FROM seen_nonces");
    expect(remaining.rows.map((r) => r.nonce)).toEqual(["fresh"]);
  });
});
