/**
 * mac.test.ts — closure-secret HMAC for page-hook → content-claude channel.
 *
 * Pure-function coverage: sign/verify roundtrip, forgery rejection,
 * tamper detection, replay rejection. The DOM-side injection in
 * content-claude.ts is integration-tested manually (see PR #87 test plan)
 * because the v0.1.6 fix doesn't change how page-hook intercepts fetch,
 * only how its messages are authenticated.
 */

import { describe, it, expect } from "vitest";
import {
  signTurn,
  verifyTurn,
  generateSecret,
  secretToHex,
  hexToSecret,
  MAC_MAX_AGE_MS,
} from "../shared/mac.js";
import type { CapturedTurn } from "../shared/types.js";

const sampleTurn: CapturedTurn = {
  id: "msg_abc123",
  role: "assistant",
  content: "Hello world",
  conversation_id: "conv_xyz",
  timestamp: "2026-05-27T03:00:00.000Z",
};

describe("signTurn / verifyTurn roundtrip", () => {
  it("a signed turn verifies under the same secret", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    const ok = await verifyTurn(sampleTurn, ts, mac, secret);
    expect(ok).toBe(true);
  });

  it("ts is a recent millisecond value", async () => {
    const secret = generateSecret();
    const before = Date.now();
    const { ts } = await signTurn(sampleTurn, secret);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("mac is 64 hex chars (HMAC-SHA256)", async () => {
    const secret = generateSecret();
    const { mac } = await signTurn(sampleTurn, secret);
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verification is independent of property-insertion order in turn", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    // Re-construct with keys in a different order
    const shuffled: CapturedTurn = {
      timestamp: sampleTurn.timestamp,
      conversation_id: sampleTurn.conversation_id,
      content: sampleTurn.content,
      role: sampleTurn.role,
      id: sampleTurn.id,
    };
    const ok = await verifyTurn(shuffled, ts, mac, secret);
    expect(ok).toBe(true);
  });
});

describe("forgery + tamper rejection", () => {
  it("a turn signed under secret A does NOT verify under secret B", async () => {
    const secretA = generateSecret();
    const secretB = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secretA);
    const ok = await verifyTurn(sampleTurn, ts, mac, secretB);
    expect(ok).toBe(false);
  });

  it("tampering with turn.content invalidates the mac", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    const tampered: CapturedTurn = { ...sampleTurn, content: "INJECTED" };
    const ok = await verifyTurn(tampered, ts, mac, secret);
    expect(ok).toBe(false);
  });

  it("tampering with ts invalidates the mac", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    const ok = await verifyTurn(sampleTurn, ts + 1, mac, secret);
    expect(ok).toBe(false);
  });

  it("a forged-shape message with no real mac (random hex of right length) is rejected", async () => {
    const secret = generateSecret();
    const fakeMac = "00".repeat(32);
    const ok = await verifyTurn(sampleTurn, Date.now(), fakeMac, secret);
    expect(ok).toBe(false);
  });

  it("a non-hex mac string is rejected without throwing", async () => {
    const secret = generateSecret();
    const ok = await verifyTurn(sampleTurn, Date.now(), "not-hex-at-all-!!!", secret);
    expect(ok).toBe(false);
  });
});

describe("replay / freshness rejection", () => {
  it("a turn older than MAC_MAX_AGE_MS is rejected even with a valid mac", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    // Pretend the message is 2 * MAC_MAX_AGE_MS old
    const ancient = ts - MAC_MAX_AGE_MS * 2;
    // Re-sign at the old ts so the mac itself is valid for that ts —
    // this isolates the freshness check from the mac check.
    // (Simulates an attacker replaying a captured-and-stored message.)
    const replayed = await signTurnAt(sampleTurn, secret, ancient);
    const ok = await verifyTurn(sampleTurn, ancient, replayed.mac, secret);
    expect(ok).toBe(false);
  });

  it("a turn within the freshness window is accepted", async () => {
    const secret = generateSecret();
    const { ts, mac } = await signTurn(sampleTurn, secret);
    const ok = await verifyTurn(sampleTurn, ts, mac, secret, MAC_MAX_AGE_MS);
    expect(ok).toBe(true);
  });

  it("ts in the far future is rejected (clock-skew bound)", async () => {
    const secret = generateSecret();
    const futureTs = Date.now() + MAC_MAX_AGE_MS * 10;
    const replayed = await signTurnAt(sampleTurn, secret, futureTs);
    const ok = await verifyTurn(sampleTurn, futureTs, replayed.mac, secret);
    expect(ok).toBe(false);
  });

  it("non-numeric ts is rejected", async () => {
    const secret = generateSecret();
    const ok = await verifyTurn(sampleTurn, NaN, "00".repeat(32), secret);
    expect(ok).toBe(false);
  });
});

describe("secret helpers", () => {
  it("generateSecret produces 32 bytes", () => {
    const s = generateSecret();
    expect(s.length).toBe(32);
  });

  it("secretToHex / hexToSecret roundtrip", () => {
    const s = generateSecret();
    const hex = secretToHex(s);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const back = hexToSecret(hex);
    expect(Array.from(back)).toEqual(Array.from(s));
  });
});

// ---------------------------------------------------------------------------
// Helper: sign with a forced timestamp so we can construct replay scenarios.
// Mirrors signTurn but bypasses Date.now() so the test can drive ts directly.
// ---------------------------------------------------------------------------
async function signTurnAt(
  turn: CapturedTurn,
  secret: Uint8Array,
  ts: number,
): Promise<{ ts: number; mac: string }> {
  const subtle = (globalThis as { crypto: Crypto }).crypto.subtle;
  const enc = new TextEncoder();
  const keys = Object.keys(turn).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = (turn as unknown as Record<string, unknown>)[k];
  const canonical = JSON.stringify(obj);
  const key = await subtle.importKey(
    "raw",
    secret as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign(
    "HMAC",
    key,
    enc.encode(`${canonical}|${ts}`) as unknown as ArrayBuffer,
  );
  const view = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return { ts, mac: hex };
}
