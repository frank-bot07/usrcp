import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeMemDb, makeKeyPair } from "./helpers.js";
import { Db } from "../db.js";
import { createApp } from "../server.js";
import { signRequest } from "../auth.js";
import {
  loadConfigFromEnv,
  DEFAULT_RATE_LIMIT_CONFIG,
  type RateLimitConfig,
} from "../rate-limit.js";

let db: Db;

beforeEach(async () => {
  const env = makeMemDb();
  db = env.db;
  await db.migrate();
});

afterEach(async () => {
  await db.close();
});

function makeAppWithLimit(limit: Partial<RateLimitConfig>): FastifyInstance {
  const config: RateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...limit };
  return createApp({ db, logger: false, rateLimit: config });
}

function injectFrom(
  app: FastifyInstance,
  ip: string,
  method: "GET" | "POST",
  url: string,
  body?: string
) {
  return app.inject({
    method,
    url,
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    payload: body,
    remoteAddress: ip,
  });
}

describe("loadConfigFromEnv", () => {
  it("uses defaults when env is empty", () => {
    const c = loadConfigFromEnv({});
    expect(c.signedRpmDefault).toBe(DEFAULT_RATE_LIMIT_CONFIG.signedRpmDefault);
    expect(c.pairingClaimRpm).toBe(DEFAULT_RATE_LIMIT_CONFIG.pairingClaimRpm);
    expect(c.trustProxy).toBe(false);
  });

  it("parses positive numbers and falls back to defaults on garbage", () => {
    const c = loadConfigFromEnv({
      RATE_LIMIT_SIGNED_RPM: "1234",
      RATE_LIMIT_PAIRING_CLAIM_RPM: "not-a-number",
      RATE_LIMIT_PROBE_CODES: "0", // zero/negative is rejected
      TRUST_PROXY: "true",
    });
    expect(c.signedRpmDefault).toBe(1234);
    expect(c.pairingClaimRpm).toBe(DEFAULT_RATE_LIMIT_CONFIG.pairingClaimRpm);
    expect(c.pairingDistinctCodesPerWindow).toBe(DEFAULT_RATE_LIMIT_CONFIG.pairingDistinctCodesPerWindow);
    expect(c.trustProxy).toBe(true);
  });
});

describe("rate limits", () => {
  it("/healthz is never rate-limited", async () => {
    const app = makeAppWithLimit({
      signedRpmDefault: 1,
      pairingClaimRpm: 1,
      pairingInitRpm: 1,
    });
    await app.ready();
    for (let i = 0; i < 10; i++) {
      const res = await injectFrom(app, "1.2.3.4", "GET", "/healthz");
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("blocks the unauthenticated claim endpoint after pairingClaimRpm hits from the same IP", async () => {
    const app = makeAppWithLimit({
      pairingClaimRpm: 3,
      trustProxy: true,
    });
    await app.ready();

    // 3 successful (404 because no row, but the route ran) + then 429.
    for (let i = 0; i < 3; i++) {
      const res = await injectFrom(app, "10.0.0.1", "GET", "/v1/pairing/claim/1234567" + i);
      expect(res.statusCode).toBe(404);
    }
    const blocked = await injectFrom(app, "10.0.0.1", "GET", "/v1/pairing/claim/99999999");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();

    // A DIFFERENT IP is unaffected.
    const other = await injectFrom(app, "10.0.0.2", "GET", "/v1/pairing/claim/12345678");
    expect(other.statusCode).toBe(404);

    await app.close();
  });

  it("blocks distinct-code probing across many codes from the same IP", async () => {
    const app = makeAppWithLimit({
      pairingClaimRpm: 1000, // big - we want to test the probe path, not the rate counter
      pairingDistinctCodesPerWindow: 4,
      trustProxy: true,
    });
    await app.ready();

    // Probe 4 DIFFERENT codes. Each returns 404 (no row exists).
    for (let i = 0; i < 4; i++) {
      const res = await injectFrom(app, "10.0.0.3", "GET", `/v1/pairing/claim/${10000000 + i}`);
      expect(res.statusCode).toBe(404);
    }
    // The 5th distinct code trips the probe detector.
    const blocked = await injectFrom(app, "10.0.0.3", "GET", "/v1/pairing/claim/10000004");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("PROBE_DETECTED");

    // Hitting the SAME code repeatedly does NOT count as new distinct codes.
    const app2 = makeAppWithLimit({
      pairingClaimRpm: 1000,
      pairingDistinctCodesPerWindow: 4,
      trustProxy: true,
    });
    await app2.ready();
    for (let i = 0; i < 6; i++) {
      const res = await injectFrom(app2, "10.0.0.4", "GET", "/v1/pairing/claim/55555555");
      // Some of these hit 429 due to per-code attempt cap inside the route,
      // but never 429 from the PROBE_DETECTED path because the distinct
      // count is still 1.
      expect([200, 404, 429]).toContain(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.json().error).not.toBe("PROBE_DETECTED");
      }
    }
    await app.close();
    await app2.close();
  });

  it("blocks signed routes at signedRpmDefault per IP", async () => {
    const app = makeAppWithLimit({
      signedRpmDefault: 3,
      trustProxy: true,
    });
    await app.ready();
    const { privateKeyPem, publicKeyPem } = makeKeyPair();

    function sign(method: "GET" | "POST", url: string, body: string) {
      const signed = signRequest(privateKeyPem, method, url, body);
      return {
        "x-forwarded-for": "10.0.0.5",
        "content-type": "application/json",
        "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
        "x-usrcp-timestamp": String(signed.timestampMs),
        "x-usrcp-nonce": signed.nonce,
        "x-usrcp-signature": signed.signature,
      } as Record<string, string>;
    }

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/state",
        headers: sign("GET", "/v1/state", ""),
        remoteAddress: "10.0.0.5",
      });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/state",
      headers: sign("GET", "/v1/state", ""),
      remoteAddress: "10.0.0.5",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");

    await app.close();
  });

  it("X-Forwarded-For is ignored when trustProxy is false", async () => {
    // Even if a malicious client claims to be a different IP via XFF,
    // the limiter must attribute requests to the real TCP peer.
    const app = makeAppWithLimit({
      pairingClaimRpm: 2,
      trustProxy: false,
    });
    await app.ready();

    // Attacker rotates X-Forwarded-For but all requests share remoteAddress.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/pairing/claim/1111111${i}`,
        headers: { "x-forwarded-for": `192.168.0.${i}` },
        remoteAddress: "10.0.0.6",
      });
      expect(res.statusCode).toBe(404);
    }
    const blocked = await app.inject({
      method: "GET",
      url: "/v1/pairing/claim/22222222",
      headers: { "x-forwarded-for": "192.168.0.99" },
      remoteAddress: "10.0.0.6",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");

    await app.close();
  });

  it("the probe map stays bounded even when the same IP keeps scanning after a block", async () => {
    // The probe detector must not grow its per-IP set indefinitely
    // under sustained attack. observe() caps the set at threshold+1.
    const { _internal } = await import("../rate-limit.js");
    const probe = new _internal.DistinctProbeTracker();
    const now = Date.now();
    const HARD_CAP = 6; // threshold+1 for a 5-code threshold

    // Probe 100 distinct codes from the same IP within the window.
    for (let i = 0; i < 100; i++) {
      probe.observe("10.0.0.99", String(20000000 + i), now + i, 60_000, HARD_CAP);
    }
    // Set size must not exceed the cap.
    expect(probe.size()).toBeLessThanOrEqual(HARD_CAP);
  });

  it("rate-limits POSTs at onRequest BEFORE the body is parsed", async () => {
    // A flood of oversized POSTs to /v1/pairing/init must hit 429 from
    // the rate limiter, not 413 from the body-size guard or 200 after
    // the body has been JSON.parsed. Because the hook runs at
    // onRequest (before preParsing/the JSON parser), the rejected
    // request never spends the CPU on the body.
    const app = makeAppWithLimit({
      pairingInitRpm: 2,
      trustProxy: true,
    });
    await app.ready();
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const big = "x".repeat(50_000); // not over 2 MiB; enough to be wasteful
    const body = JSON.stringify({ code: "12345678", encrypted_bundle: big });

    function sign() {
      const signed = signRequest(privateKeyPem, "POST", "/v1/pairing/init", body);
      return {
        "x-forwarded-for": "10.0.0.10",
        "content-type": "application/json",
        "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
        "x-usrcp-timestamp": String(signed.timestampMs),
        "x-usrcp-nonce": signed.nonce,
        "x-usrcp-signature": signed.signature,
      } as Record<string, string>;
    }

    // First 2 go through (will 400 because the bundle isn't real ciphertext;
    // we just want any non-429 status to confirm the route ran).
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/pairing/init",
        headers: sign(),
        payload: body,
        remoteAddress: "10.0.0.10",
      });
      expect(res.statusCode).not.toBe(429);
    }
    // 3rd request must 429 from rate limiter, NOT 413/400 from later stages.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/pairing/init",
      headers: sign(),
      payload: body,
      remoteAddress: "10.0.0.10",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");

    await app.close();
  });

  it("can be disabled entirely with rateLimit:false (used in the existing test suites)", async () => {
    const app = createApp({ db, logger: false, rateLimit: false });
    await app.ready();
    for (let i = 0; i < 100; i++) {
      const res = await injectFrom(app, "10.0.0.7", "GET", "/v1/pairing/claim/1234567" + (i % 10));
      // 404 because the row doesn't exist; rate limiter is bypassed.
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });
});
