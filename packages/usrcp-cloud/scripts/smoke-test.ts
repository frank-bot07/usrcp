#!/usr/bin/env node
/**
 * Deploy smoke test for the hosted ledger.
 *
 *   USRCP_CLOUD_ENDPOINT=https://usrcp-cloud.up.railway.app \
 *     npx tsx scripts/smoke-test.ts
 *
 * Exercises the three sync endpoints + auth gate against a live
 * deployment. Generates a fresh Ed25519 keypair each run so it doesn't
 * collide with any real user's key. Exits non-zero on any failure.
 *
 * Five checks:
 *   1. GET /healthz                            → 200 { status: "ok" }
 *   2. POST /v1/events WITHOUT auth            → 401 MISSING_AUTH_HEADERS
 *   3. POST /v1/events signed                  → 200 with ledger_sequence=1
 *   4. GET  /v1/state?since=0 signed           → 200 with events[0]
 *   5. Replay the same signed request          → 401 REPLAY_DETECTED
 */

import * as crypto from "node:crypto";

// KEEP IN SYNC WITH packages/usrcp-cloud/src/auth.ts (canonicalRequest,
// signRequest) and packages/usrcp-local/src/sync.ts. Duplicated here so
// this script stays a single file that can be tsx-run without needing
// the whole package built.
function canonicalRequest(
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return Buffer.from(
    [method.toUpperCase(), path, String(timestampMs), nonce, bodyHash].join("\n"),
    "utf8"
  );
}

function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
  body: string,
  opts: { timestampMs?: number; nonce?: string } = {}
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = opts.timestampMs ?? Date.now();
  const nonce = opts.nonce ?? crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, path, timestampMs, nonce, body);
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, canon, key);
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}

interface SignedFetchResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

async function callSigned(
  endpoint: string,
  path: string,
  method: "GET" | "POST",
  body: unknown | undefined,
  publicKeyPem: string,
  privateKeyPem: string,
  reuseNonce?: { timestampMs: number; nonce: string; signature: string }
): Promise<SignedFetchResult> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signed = reuseNonce ?? signRequest(privateKeyPem, method, path, bodyStr);
  const url = endpoint.replace(/\/$/, "") + path;
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
    body: method === "POST" ? bodyStr : undefined,
  });
  let parsedBody: any = null;
  const text = await res.text();
  try {
    parsedBody = text ? JSON.parse(text) : null;
  } catch {
    parsedBody = text;
  }
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => { hdrs[k] = v; });
  return { status: res.status, body: parsedBody, headers: hdrs };
}

async function callUnsigned(
  endpoint: string,
  path: string,
  method: "GET" | "POST"
): Promise<SignedFetchResult> {
  const url = endpoint.replace(/\/$/, "") + path;
  const res = await fetch(url, { method });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => { hdrs[k] = v; });
  return { status: res.status, body, headers: hdrs };
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    process.stdout.write(`  ✅  ${name}\n`);
    passed++;
  } else {
    process.stdout.write(`  ❌  ${name}${detail ? ` — ${detail}` : ""}\n`);
    failed++;
  }
}

async function main() {
  const endpoint =
    process.env.USRCP_CLOUD_ENDPOINT ??
    process.argv.slice(2).find((a) => a.startsWith("http"));

  if (!endpoint) {
    process.stderr.write(
      "Usage: USRCP_CLOUD_ENDPOINT=<url> npx tsx scripts/smoke-test.ts\n"
    );
    process.exit(2);
  }

  process.stdout.write(`\n  USRCP cloud smoke test\n  Target: ${endpoint}\n\n`);

  // Fresh keypair per run — doesn't stomp on a real user's state.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKeyPem = publicKey as string;
  const privateKeyPem = privateKey as string;

  // Check 1: healthz reachable + unauth
  try {
    const res = await callUnsigned(endpoint, "/healthz", "GET");
    check(
      "GET /healthz returns 200 with {status: 'ok'}",
      res.status === 200 && res.body?.status === "ok",
      `status=${res.status} body=${JSON.stringify(res.body)}`
    );
  } catch (err: any) {
    check("GET /healthz reachable", false, `fetch error: ${err?.message ?? err}`);
  }

  // Check 2: unsigned request is rejected
  try {
    const res = await callUnsigned(endpoint, "/v1/events", "POST");
    check(
      "POST /v1/events unsigned → 401 MISSING_AUTH_HEADERS",
      res.status === 401 && res.body?.error === "MISSING_AUTH_HEADERS",
      `status=${res.status} error=${res.body?.error}`
    );
  } catch (err: any) {
    check("POST /v1/events unsigned reachable", false, `fetch error: ${err?.message ?? err}`);
  }

  // Check 3: signed POST /v1/events with one event
  const seededEvent = {
    event_id: "smoke-" + crypto.randomBytes(6).toString("hex"),
    client_timestamp: new Date().toISOString(),
    domain_pseudonym: "d_smoketest000",
    summary_enc: "enc:AAAA-smoke-test-ciphertext-AAAA",
    idempotency_key: "smoke-" + crypto.randomBytes(6).toString("hex"),
  };
  try {
    const res = await callSigned(
      endpoint,
      "/v1/events",
      "POST",
      { events: [seededEvent] },
      publicKeyPem,
      privateKeyPem
    );
    const accepted = res.body?.accepted?.[0];
    check(
      "POST /v1/events signed → 200 with ledger_sequence",
      res.status === 200 && typeof accepted?.ledger_sequence === "number",
      `status=${res.status} body=${JSON.stringify(res.body)}`
    );
  } catch (err: any) {
    check("POST /v1/events signed", false, `fetch error: ${err?.message ?? err}`);
  }

  // Check 4: signed GET /v1/state returns the event we just wrote
  try {
    const res = await callSigned(
      endpoint,
      "/v1/state?since=0&limit=10",
      "GET",
      undefined,
      publicKeyPem,
      privateKeyPem
    );
    const found = (res.body?.events ?? []).find(
      (e: any) => e.event_id === seededEvent.event_id
    );
    check(
      "GET /v1/state signed → round-trip finds the written event",
      res.status === 200 && Boolean(found),
      `status=${res.status} found=${Boolean(found)} event_count=${res.body?.events?.length}`
    );
  } catch (err: any) {
    check("GET /v1/state signed", false, `fetch error: ${err?.message ?? err}`);
  }

  // Check 5: replay — same signed request with the same nonce must 401
  const replayPayload = { events: [seededEvent] };
  const replaySigned = signRequest(
    privateKeyPem,
    "POST",
    "/v1/events",
    JSON.stringify(replayPayload),
    { nonce: "deadbeefcafe0000" }
  );
  try {
    // First use — should succeed (or idempotency dedupe — still 200)
    const first = await callSigned(
      endpoint,
      "/v1/events",
      "POST",
      replayPayload,
      publicKeyPem,
      privateKeyPem,
      replaySigned
    );
    if (first.status !== 200) {
      check(
        "replay setup: first signed call succeeds",
        false,
        `status=${first.status} body=${JSON.stringify(first.body)}`
      );
    } else {
      const second = await callSigned(
        endpoint,
        "/v1/events",
        "POST",
        replayPayload,
        publicKeyPem,
        privateKeyPem,
        replaySigned
      );
      check(
        "POST with replayed nonce → 401 REPLAY_DETECTED",
        second.status === 401 && second.body?.error === "REPLAY_DETECTED",
        `status=${second.status} error=${second.body?.error}`
      );
    }
  } catch (err: any) {
    check("replay detection", false, `fetch error: ${err?.message ?? err}`);
  }

  process.stdout.write(`\n  ${passed} passed, ${failed} failed\n\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
