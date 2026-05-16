/**
 * Multi-device pairing.
 *
 * Device A: `pairInit` - bundles the local identity (salt, verify, identity.json,
 * encrypted private.pem), encrypts it under scrypt(code, FIXED_PAIRING_SALT),
 * and POSTs the ciphertext to /v1/pairing/init. Returns the 8-digit code.
 *
 * Device B: `pairJoin` - GETs the ciphertext, decrypts with scrypt(code,
 * FIXED_PAIRING_SALT), writes the four key files atomically into the target
 * userDir/keys/, and validates the passphrase by calling initializeMasterKey
 * + getDecryptedPrivateKeyPem. On any failure the partial writes are rolled
 * back so the userDir is left empty.
 *
 * The server never sees the bundle plaintext. See tasks/11-multi-device-pairing.md
 * for the threat model.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  deriveFromPairingCode,
  safeWriteFile,
  initializeMasterKey,
  setUserSlug,
  getUserSlug,
  zeroBuffer,
} from "./encryption.js";
import { getDecryptedPrivateKeyPem, type LedgerIdentity } from "./crypto.js";

const PAIRING_BUNDLE_SCHEMA_V = 1;
const MIN_BUNDLE_LEN = 16;

export class InvalidPairingCode extends Error {
  constructor(message = "Invalid pairing code or bundle decryption failed.") {
    super(message);
    this.name = "InvalidPairingCode";
  }
}

export class WrongPassphrase extends Error {
  constructor(message = "Wrong passphrase for the pairing bundle.") {
    super(message);
    this.name = "WrongPassphrase";
  }
}

export class PairingExpired extends Error {
  constructor(message = "Pairing code expired or never existed.") {
    super(message);
    this.name = "PairingExpired";
  }
}

export class PairingLocked extends Error {
  constructor(message = "Pairing code locked after too many attempts. Re-init on device A.") {
    super(message);
    this.name = "PairingLocked";
  }
}

interface PairingBundle {
  schema_v: number;
  salt: string;             // base64(master.salt)
  verify: string;           // base64(master.verify)
  identity: LedgerIdentity;
  private_pem_enc: string;  // contents of private.pem (already enc:... ciphertext)
}

// --- Signing (kept in sync with packages/usrcp-cloud/src/auth.ts) ---

function canonicalRequest(
  method: string,
  pathWithQuery: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return Buffer.from(
    [method.toUpperCase(), pathWithQuery, String(timestampMs), nonce, bodyHash].join("\n"),
    "utf8"
  );
}

function signRequest(
  privateKeyPem: string,
  method: string,
  pathWithQuery: string,
  body: string
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, pathWithQuery, timestampMs, nonce, body);
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(privateKeyPem));
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}

async function signedFetch(
  endpoint: string,
  pathWithQuery: string,
  method: "GET" | "POST" | "DELETE",
  body: unknown | undefined,
  publicKeyPem: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; json: any }> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signed = signRequest(privateKeyPem, method, pathWithQuery, bodyStr);
  const url = endpoint.replace(/\/$/, "") + pathWithQuery;
  const res = await fetchImpl(url, {
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
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// --- Helpers shared by pairInit / pairJoin ---

function keysDirOf(userDir: string): string {
  return path.join(userDir, "keys");
}

function readBundleSources(userDir: string): PairingBundle {
  const keysDir = keysDirOf(userDir);
  const saltPath = path.join(keysDir, "master.salt");
  const verifyPath = path.join(keysDir, "master.verify");
  const identityPath = path.join(keysDir, "identity.json");
  const privatePath = path.join(keysDir, "private.pem");

  for (const p of [saltPath, verifyPath, identityPath, privatePath]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `pairInit: missing required key file ${p}. The local ledger must be ` +
        `initialized in passphrase mode before pairing.`
      );
    }
  }

  const salt = fs.readFileSync(saltPath);
  const verify = fs.readFileSync(verifyPath);
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf-8")) as LedgerIdentity;
  const privatePemEnc = fs.readFileSync(privatePath, "utf-8").trim();

  if (!privatePemEnc.startsWith("enc:")) {
    throw new Error(
      "pairInit: private.pem is plaintext (legacy v0.1.x). Run a master-key " +
      "rotation first so it is encrypted before being included in a pairing bundle."
    );
  }

  return {
    schema_v: PAIRING_BUNDLE_SCHEMA_V,
    salt: salt.toString("base64"),
    verify: verify.toString("base64"),
    identity,
    private_pem_enc: privatePemEnc,
  };
}

function randomEightDigit(): string {
  // crypto.randomInt(min, max) - max is exclusive. We need 10_000_000-99_999_999.
  const n = crypto.randomInt(10_000_000, 100_000_000);
  return String(n);
}

// --- pairInit ---

export interface PairInitOpts {
  userDir: string;
  publicKeyPem: string;
  privateKeyPem: string;
  endpoint: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}

export async function pairInit(opts: PairInitOpts): Promise<{
  code: string;
  expires_at: string;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const bundle = readBundleSources(opts.userDir);
  const bundleJson = JSON.stringify(bundle);

  // 3 attempts gives effectively-zero chance of repeated cross-user collisions.
  // The server's 409 CODE_COLLISION is the only retryable error here.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomEightDigit();
    const key = deriveFromPairingCode(code);
    let encryptedBundle: string;
    try {
      encryptedBundle = encrypt(bundleJson, key);
    } finally {
      zeroBuffer(key);
    }

    const body: Record<string, unknown> = { code, encrypted_bundle: encryptedBundle };
    if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;

    const { status, json } = await signedFetch(
      opts.endpoint,
      "/v1/pairing/init",
      "POST",
      body,
      opts.publicKeyPem,
      opts.privateKeyPem,
      fetchImpl
    );

    if (status === 200) {
      return { code, expires_at: String(json?.expires_at ?? "") };
    }
    if (status === 409 && json?.error === "CODE_COLLISION") {
      continue; // pick a new code
    }
    throw new Error(
      `pairInit failed: HTTP ${status} ${JSON.stringify(json ?? null)}`
    );
  }
  throw new Error("pairInit failed: three CODE_COLLISION attempts in a row.");
}

// --- pairJoin ---

export interface PairJoinOpts {
  userDir: string;
  passphrase: string;
  endpoint: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
}

export async function pairJoin(
  code: string,
  opts: PairJoinOpts
): Promise<{ user_id: string; public_key: string }> {
  if (!/^[0-9]{8}$/.test(code)) {
    throw new InvalidPairingCode("Pairing code must be exactly 8 digits.");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const keysDir = keysDirOf(opts.userDir);
  const identityPath = path.join(keysDir, "identity.json");
  if (fs.existsSync(identityPath) && !opts.force) {
    throw new Error(
      `pairJoin: ${identityPath} already exists. Pass force: true to overwrite.`
    );
  }

  // Unauthenticated GET - device B has no identity yet.
  const url = opts.endpoint.replace(/\/$/, "") + `/v1/pairing/claim/${code}`;
  const res = await fetchImpl(url, { method: "GET" });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 404) throw new PairingExpired();
  if (res.status === 429) throw new PairingLocked();
  if (res.status !== 200) {
    throw new Error(`pairJoin: claim failed: HTTP ${res.status} ${JSON.stringify(json ?? null)}`);
  }
  const ciphertext = String(json?.encrypted_bundle ?? "");
  if (ciphertext.length < MIN_BUNDLE_LEN) {
    throw new Error("pairJoin: server returned a too-short bundle.");
  }
  // Defense in depth: `decrypt()` returns non-`enc:` input verbatim for
  // pre-v0.1.3 plaintext compatibility. A malicious server could exploit
  // that to serve a plaintext JSON bundle that bypasses the scrypt-derived
  // pairing key entirely. Refuse anything that isn't authenticated
  // ciphertext before handing it to decrypt().
  if (!ciphertext.startsWith("enc:")) {
    throw new InvalidPairingCode("Pairing bundle is not ciphertext; refusing.");
  }

  const key = deriveFromPairingCode(code);
  let bundle: PairingBundle;
  try {
    let bundleJson: string;
    try {
      bundleJson = decrypt(ciphertext, key);
    } catch {
      throw new InvalidPairingCode();
    }
    try {
      bundle = JSON.parse(bundleJson);
    } catch {
      throw new InvalidPairingCode("Pairing bundle was not valid JSON after decryption.");
    }
  } finally {
    zeroBuffer(key);
  }

  if (bundle.schema_v !== PAIRING_BUNDLE_SCHEMA_V) {
    throw new Error(`pairJoin: unsupported bundle schema_v=${bundle.schema_v}`);
  }
  if (!bundle.identity?.public_key || !bundle.identity?.user_id) {
    throw new Error("pairJoin: bundle is missing required identity fields.");
  }
  if (!bundle.private_pem_enc?.startsWith("enc:")) {
    throw new Error("pairJoin: bundle private_pem_enc is not ciphertext.");
  }

  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  // Snapshot the prior on-disk state of every path we're about to write so
  // a failed pairJoin (wrong passphrase, malformed bundle, etc.) can restore
  // the original keys/ rather than leaving the user identity-less. Without
  // this, --force or a partially-populated keys/ dir would lose their
  // contents on rollback: safeWriteFile renames a tmp file over the target,
  // clobbering the original, and then the rollback unlinks the new file too.
  const writtenPaths: string[] = [];
  const priorState = new Map<string, { content: Buffer; mode: number } | null>();
  const writeAndTrack = (p: string, content: Buffer, mode: number) => {
    if (!priorState.has(p)) {
      if (fs.existsSync(p)) {
        try {
          priorState.set(p, {
            content: fs.readFileSync(p),
            mode: fs.statSync(p).mode & 0o7777,
          });
        } catch {
          priorState.set(p, null);
        }
      } else {
        priorState.set(p, null);
      }
    }
    safeWriteFile(p, content, mode);
    writtenPaths.push(p);
  };

  try {
    writeAndTrack(path.join(keysDir, "master.salt"), Buffer.from(bundle.salt, "base64"), 0o600);
    writeAndTrack(path.join(keysDir, "master.verify"), Buffer.from(bundle.verify, "base64"), 0o600);
    writeAndTrack(path.join(keysDir, "mode"), Buffer.from("passphrase"), 0o600);
    writeAndTrack(
      path.join(keysDir, "private.pem"),
      Buffer.from(bundle.private_pem_enc, "utf8"),
      0o600
    );
    writeAndTrack(
      path.join(keysDir, "public.pem"),
      Buffer.from(bundle.identity.public_key, "utf8"),
      0o644
    );
    writeAndTrack(
      identityPath,
      Buffer.from(JSON.stringify(bundle.identity, null, 2), "utf8"),
      0o600
    );

    // End-to-end validation: derive the master key from the passphrase via the
    // bundled salt + verify, then decrypt private.pem with it. Any failure here
    // means the user typed the wrong passphrase; roll back.
    let masterKey: Buffer;
    try {
      masterKey = initializeMasterKey(opts.passphrase);
    } catch (err) {
      if (err instanceof Error && /Invalid passphrase/i.test(err.message)) {
        throw new WrongPassphrase();
      }
      throw err;
    }
    try {
      getDecryptedPrivateKeyPem(masterKey); // throws on bad decrypt
    } finally {
      zeroBuffer(masterKey);
    }

    return {
      user_id: bundle.identity.user_id,
      public_key: bundle.identity.public_key,
    };
  } catch (err) {
    // Rollback: restore the pre-existing content where the file existed
    // before we wrote, otherwise unlink. Best-effort: if restore fails for
    // any reason, leave the file as-is rather than risk destroying both
    // versions; the user can re-run pairJoin.
    for (const p of writtenPaths) {
      const prior = priorState.get(p) ?? null;
      if (prior) {
        try {
          safeWriteFile(p, prior.content, prior.mode);
        } catch { /* best effort */ }
      } else {
        try { fs.unlinkSync(p); } catch { /* best effort */ }
      }
    }
    throw err;
  }
}

// --- pairStatus / pairCancel ---

export interface PairAuthOpts {
  publicKeyPem: string;
  privateKeyPem: string;
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export interface PairStatusEntry {
  code: string;
  expires_at: string;
  claim_attempts: number;
}

export async function pairStatus(opts: PairAuthOpts): Promise<PairStatusEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await signedFetch(
    opts.endpoint,
    "/v1/pairing/list",
    "GET",
    undefined,
    opts.publicKeyPem,
    opts.privateKeyPem,
    fetchImpl
  );
  if (status !== 200) {
    throw new Error(`pairStatus: HTTP ${status} ${JSON.stringify(json ?? null)}`);
  }
  return (json?.bundles ?? []) as PairStatusEntry[];
}

export async function pairCancel(code: string, opts: PairAuthOpts): Promise<void> {
  if (!/^[0-9]{8}$/.test(code)) {
    throw new Error("pairCancel: code must be exactly 8 digits.");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await signedFetch(
    opts.endpoint,
    `/v1/pairing/${code}`,
    "DELETE",
    undefined,
    opts.publicKeyPem,
    opts.privateKeyPem,
    fetchImpl
  );
  if (status === 200) return;
  if (status === 404) throw new PairingExpired();
  throw new Error(`pairCancel: HTTP ${status} ${JSON.stringify(json ?? null)}`);
}

// Re-exported for tests that need to inspect/format the code.
export function formatCode(code: string): string {
  return /^[0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// Re-exported so the CLI can switch user slugs before/after a join without
// importing two modules.
export { setUserSlug, getUserSlug };
