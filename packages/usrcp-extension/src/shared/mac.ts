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
 * document_start, wraps page-hook source in an IIFE that captures the
 * secret in its closure, injects via <script>.textContent then removes the
 * element. page-hook computes HMAC-SHA256(secret, canonical(turn) || "|" ||
 * ts) on every post; content-claude verifies before forwarding. Attackers
 * can't forge without the secret, and the secret lives only in the closure
 * of the IIFE that's already been detached from the DOM.
 *
 * Anti-replay: messages include ts; receiver rejects if Date.now() - ts >
 * MAC_MAX_AGE_MS. A leaked message can't be replayed beyond the window.
 *
 * Race-window: a mutation observer in the MAIN world COULD read the script
 * element's textContent in the brief moment between append and remove,
 * extracting the secret. That's a residual risk we accept for v0.1.6 — the
 * fix raises the bar from "trivial shape forgery" to "race document_start
 * injection," which is a meaningful improvement and matches the strongest
 * guarantee that's achievable without architectural changes (e.g. moving
 * capture entirely into a debugger-protocol attach).
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

const SUBTLE = (globalThis as { crypto?: Crypto }).crypto?.subtle;

if (!SUBTLE) {
  throw new Error("[usrcp] crypto.subtle unavailable; cannot sign/verify messages");
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

async function importKey(secret: Uint8Array): Promise<CryptoKey> {
  return SUBTLE.importKey(
    "raw",
    secret as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < view.length; i++) {
    s += view[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
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
  secret: Uint8Array,
): Promise<{ ts: number; mac: string }> {
  const ts = Date.now();
  const key = await importKey(secret);
  const payload = ENCODER.encode(`${canonical(turn)}|${ts}`);
  const sig = await SUBTLE.sign("HMAC", key, payload as unknown as ArrayBuffer);
  return { ts, mac: bytesToHex(sig) };
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
  secret: Uint8Array,
  maxAgeMs: number = MAC_MAX_AGE_MS,
): Promise<boolean> {
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > maxAgeMs) return false;
  let macBytes: Uint8Array;
  try {
    macBytes = hexToBytes(mac);
  } catch {
    return false;
  }
  const key = await importKey(secret);
  const payload = ENCODER.encode(`${canonical(turn)}|${ts}`);
  return SUBTLE.verify(
    "HMAC",
    key,
    macBytes as unknown as ArrayBuffer,
    payload as unknown as ArrayBuffer,
  );
}

/**
 * Generate a fresh 32-byte secret. Caller passes this into both the
 * injected page-hook IIFE (signing) and content-claude's verifier.
 */
export function generateSecret(): Uint8Array {
  const out = new Uint8Array(32);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(out);
  return out;
}

export function secretToHex(secret: Uint8Array): string {
  return bytesToHex(secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength));
}

export function hexToSecret(hex: string): Uint8Array {
  return hexToBytes(hex);
}
