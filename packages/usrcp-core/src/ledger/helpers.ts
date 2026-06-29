import * as path from "node:path";
import * as crypto from "node:crypto";
import { getUserDir } from "../encryption.js";

export function getDefaultDbPath(): string {
  return path.join(getUserDir(), "ledger.db");
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// --- Spec-compliant ULID (Crockford Base32, monotonic within ms) ---

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: Uint8Array | null = null;

export function generateULID(): string {
  let now = Date.now();

  if (now === lastTime && lastRandom) {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 255) {
        lastRandom[i]++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(crypto.randomBytes(10));
  }

  let ts = "";
  for (let i = 9; i >= 0; i--) {
    ts = CROCKFORD[now & 0x1f] + ts;
    now = Math.floor(now / 32);
  }

  let rnd = "";
  const bytes = lastRandom!;
  for (let group = 0; group < 2; group++) {
    const off = group * 5;
    const b0 = bytes[off];
    const b1 = bytes[off + 1];
    const b2 = bytes[off + 2];
    const b3 = bytes[off + 3];
    const b4 = bytes[off + 4];

    rnd += CROCKFORD[(b0 >> 3) & 0x1f];
    rnd += CROCKFORD[((b0 << 2) | (b1 >> 6)) & 0x1f];
    rnd += CROCKFORD[(b1 >> 1) & 0x1f];
    rnd += CROCKFORD[((b1 << 4) | (b2 >> 4)) & 0x1f];
    rnd += CROCKFORD[((b2 << 1) | (b3 >> 7)) & 0x1f];
    rnd += CROCKFORD[(b3 >> 2) & 0x1f];
    rnd += CROCKFORD[((b3 << 3) | (b4 >> 5)) & 0x1f];
    rnd += CROCKFORD[b4 & 0x1f];
  }

  return ts + rnd;
}
