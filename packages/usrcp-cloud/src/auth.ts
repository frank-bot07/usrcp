/**
 * Ed25519-signed request authentication.
 *
 * Every request carries three headers:
 *   X-USRCP-PublicKey:  PEM-encoded Ed25519 public key (identifies the user)
 *   X-USRCP-Timestamp:  Unix milliseconds (rejects requests with |now - ts| > window)
 *   X-USRCP-Nonce:      random 16-hex-char string (replay protection within window)
 *   X-USRCP-Signature:  base64url(sign(method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body)))
 *
 * First write with a new public key implicitly registers the user. No
 * accounts, no email, no OAuth. This is Phase 1.
 */

import * as crypto from "node:crypto";
import type { Db } from "./db.js";

// Reject timestamps outside this window (ms). 5 minutes is Stripe's default.
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export interface AuthenticatedRequest {
  publicKeyPem: string;
  userPublicKey: string; // same as publicKeyPem — clearer name at call sites
  timestampMs: number;
  nonce: string;
}

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number = 401) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "AuthError";
  }
}

/**
 * Compute the canonical bytes that the client must have signed.
 * Any change to this function is a protocol-breaking change.
 *
 * KEEP IN SYNC WITH packages/usrcp-local/src/sync.ts (canonicalRequest, signRequest).
 * Changes must land in both files in the same commit or signatures silently break.
 */
export function canonicalRequest(
  method: string,
  path: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canon = [method.toUpperCase(), path, String(timestampMs), nonce, bodyHash].join("\n");
  return Buffer.from(canon, "utf8");
}

/**
 * Sign a request as a client would. Exposed for tests; also used by the
 * local sync client.
 */
export function signRequest(
  privateKeyPem: string,
  method: string,
  path: string,
  body: string,
  opts: { timestampMs?: number; nonce?: string } = {}
): {
  timestampMs: number;
  nonce: string;
  signature: string;
} {
  const timestampMs = opts.timestampMs ?? Date.now();
  const nonce = opts.nonce ?? crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, path, timestampMs, nonce, body);
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, canon, key);
  return {
    timestampMs,
    nonce,
    signature: sig.toString("base64url"),
  };
}

/**
 * Verify an incoming request's signature and claim the nonce atomically.
 * Throws AuthError on any failure.
 */
export async function verifyAndClaim(
  db: Db,
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string,
  now: number = Date.now()
): Promise<AuthenticatedRequest> {
  const pub = stringHeader(headers, "x-usrcp-publickey");
  const tsStr = stringHeader(headers, "x-usrcp-timestamp");
  const nonce = stringHeader(headers, "x-usrcp-nonce");
  const sigB64 = stringHeader(headers, "x-usrcp-signature");

  if (!pub || !tsStr || !nonce || !sigB64) {
    throw new AuthError("MISSING_AUTH_HEADERS", "Missing required USRCP auth headers");
  }
  if (!pub.includes("BEGIN PUBLIC KEY")) {
    throw new AuthError("BAD_PUBLIC_KEY", "X-USRCP-PublicKey must be PEM-encoded");
  }
  if (!/^[0-9a-fA-F]{8,64}$/.test(nonce)) {
    throw new AuthError("BAD_NONCE", "X-USRCP-Nonce must be 8-64 hex chars");
  }
  const timestampMs = Number(tsStr);
  if (!Number.isFinite(timestampMs)) {
    throw new AuthError("BAD_TIMESTAMP", "X-USRCP-Timestamp must be an integer millisecond value");
  }
  if (Math.abs(now - timestampMs) > TIMESTAMP_WINDOW_MS) {
    throw new AuthError("STALE_REQUEST", `Timestamp outside ±${TIMESTAMP_WINDOW_MS}ms window`);
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(pub);
  } catch {
    throw new AuthError("BAD_PUBLIC_KEY", "Failed to parse PEM public key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new AuthError("BAD_PUBLIC_KEY", "Public key must be Ed25519");
  }

  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigB64, "base64url");
  } catch {
    throw new AuthError("BAD_SIGNATURE", "Signature must be base64url");
  }

  const canon = canonicalRequest(method, path, timestampMs, nonce, body);
  let ok = false;
  try {
    ok = crypto.verify(null, canon, publicKey, sigBytes);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new AuthError("BAD_SIGNATURE", "Signature verification failed");
  }

  // Claim the nonce atomically — prevents replay within the window.
  // INSERT will fail on PK conflict if the nonce was already seen.
  try {
    await db.query(
      "INSERT INTO seen_nonces (user_public_key, nonce) VALUES ($1, $2)",
      [pub, nonce]
    );
  } catch (err: any) {
    // pg unique_violation = 23505; pg-mem exposes the same code
    if (err?.code === "23505" || /duplicate key|unique/i.test(err?.message ?? "")) {
      throw new AuthError("REPLAY_DETECTED", "Nonce already used within window");
    }
    throw err;
  }

  // Register user on first write, update last_seen otherwise.
  await db.query(
    `INSERT INTO users (public_key) VALUES ($1)
     ON CONFLICT (public_key) DO UPDATE SET last_seen_at = now()`,
    [pub]
  );

  return { publicKeyPem: pub, userPublicKey: pub, timestampMs, nonce };
}

function stringHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Periodic cleanup of nonces older than the window. Call from a cron
 * or periodic task — leaving them forever is not a security problem,
 * but the table grows unboundedly.
 */
export async function pruneOldNonces(db: Db, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - TIMESTAMP_WINDOW_MS * 2).toISOString();
  const result = await db.query("DELETE FROM seen_nonces WHERE seen_at < $1", [cutoff]);
  return result.rowCount ?? 0;
}
