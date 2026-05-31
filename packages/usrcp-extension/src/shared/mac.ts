/**
 * mac.ts — closure-secret HMAC for the page-hook → content-claude channel.
 *
 * Why this exists (v0.1.6 fix):
 * page-hook.ts runs in the MAIN world on claude.ai. It posts captured turns
 * to the isolated-world content script via window.postMessage(msg, "*").
 * Through v0.1.5 the receiver only checked the message shape, so any same-
 * window script (XSS payload, hostile browser extension, userscript) could
 * synthesize {source:"usrcp", kind:"turn", turn:<fake>} and the content
 * script would forward it to the SW → bridge → ledger. Ledger poisoning.
 *
 * Defense: content-claude generates a fresh per-tab 32-byte secret at
 * document_start. The service worker injects a self-contained page-hook
 * function with chrome.scripting.executeScript({world:"MAIN", func, args}),
 * binding the secret atomically into the fetch-patch closure. page-hook
 * computes HMAC-SHA256(secret, canonical(turn) || "|" || ts) on every post;
 * content-claude verifies before forwarding. Attackers can't forge without
 * the secret, and no secret-bearing handoff is exposed on window or the DOM.
 *
 * Anti-replay: messages include ts; receiver rejects if Date.now() - ts >
 * MAC_MAX_AGE_MS. A leaked message can't be replayed beyond the window.
 *
 * Residual boundary: code already executing in MAIN world can still tamper
 * with fetch before or after this patch. The HMAC channel prevents direct
 * postMessage forgery; it does not make hostile page execution trustworthy.
 *
 * Implementation note: uses globalThis.crypto.subtle which exists in both
 * MAIN-world page context (browser) AND Node 16+ (for unit tests). The
 * helpers below are pure — no DOM access — so tests can run in plain
 * vitest without jsdom.
 */

import type { CapturedTurn } from "./types.js";

/**
 * Receiver rejects messages older than this. 60s leaves slack for a slow
 * background tab while still bounding replay risk.
 */
export const MAC_MAX_AGE_MS = 60_000;

/**
 * Per-call lookup so each function can re-narrow without relying on the
 * compiler to preserve module-level narrowing through async closures
 * (which TypeScript intentionally does not). Throws if Web Crypto is
 * missing — node >= 16 and any modern browser ship it.
 */
function getSubtle(): SubtleCrypto {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!s) throw new Error("[usrcp] crypto.subtle unavailable; cannot sign/verify messages");
  return s;
}

const ENCODER = new TextEncoder();

/**
 * Canonicalize a turn for signing. JSON.stringify with a stable key order
 * via Object.keys(...).sort() so signer and verifier produce byte-identical
 * inputs regardless of property insertion order.
 */
function canonical(turn: CapturedTurn): string {
  const keys = Object.keys(turn).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) {
    obj[k] = (turn as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(obj);
}

async function importKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  // Uint8Array<ArrayBuffer> satisfies BufferSource. The broad Uint8Array
  // default (Uint8Array<ArrayBufferLike>) does NOT — lib.dom's BufferSource
  // excludes SharedArrayBuffer-backed views, which is what TS2345 caught
  // when this param was the broad type.
  return getSubtle().importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

/**
 * Sign a turn. Returns {ts, mac}. Caller posts {source, kind, turn, ts, mac}.
 */
export async function signTurn(
  turn: CapturedTurn,
  secret: Uint8Array<ArrayBuffer>,
): Promise<{ ts: number; mac: string }> {
  const ts = Date.now();
  const key = await importKey(secret);
  const payload = ENCODER.encode(`${canonical(turn)}|${ts}`);
  const sig = await getSubtle().sign("HMAC", key, payload);
  return { ts, mac: bytesToHex(new Uint8Array(sig)) };
}

/**
 * Verify a turn message. Returns true iff:
 *   - ts is within MAC_MAX_AGE_MS of now (in either direction; tolerate
 *     small clock drift between MAIN-world Date.now and isolated-world)
 *   - mac is HMAC-SHA256(secret, canonical(turn)||"|"||ts)
 */
export async function verifyTurn(
  turn: CapturedTurn,
  ts: number,
  mac: string,
  secret: Uint8Array<ArrayBuffer>,
  maxAgeMs: number = MAC_MAX_AGE_MS,
): Promise<boolean> {
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > maxAgeMs) return false;
  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = hexToBytes(mac);
  } catch {
    return false;
  }
  const key = await importKey(secret);
  const payload = ENCODER.encode(`${canonical(turn)}|${ts}`);
  return getSubtle().verify("HMAC", key, macBytes, payload);
}

/**
 * Generate a fresh 32-byte secret. Caller passes this into both the
 * atomically injected page-hook function and content-claude's verifier.
 */
export function generateSecret(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(out);
  return out;
}

export function secretToHex(secret: Uint8Array<ArrayBuffer>): string {
  return bytesToHex(secret);
}

export function hexToSecret(hex: string): Uint8Array<ArrayBuffer> {
  return hexToBytes(hex);
}
