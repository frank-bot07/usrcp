/**
 * Identity rotation (client side).
 *
 * Generates a fresh Ed25519 keypair (K2), signs a rotation attestation
 * with the current key (K1), POSTs to /v1/rotate-identity authenticated
 * as K1, and on success replaces ~/.usrcp/users/<slug>/keys/{identity.json,
 * private.pem, public.pem} atomically. The new private.pem is re-encrypted
 * under the SAME master key (passphrase doesn't change), so the existing
 * passphrase still unlocks the rotated identity on this device.
 *
 * Rollback: if the cloud rejects rotation, no local files are touched.
 * If the cloud succeeds but the local write fails, the local files are
 * restored from in-memory backups and the cloud is left in the rotated
 * state - the user would re-run the command from the trusted device
 * once the local issue is resolved. (Re-running would require a fresh
 * key since K1 is already revoked; pair_join from another device is
 * the recovery path in that rare case.)
 *
 * See tasks/13-identity-rotation.md for the threat model.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  encrypt,
  deriveGlobalEncryptionKey,
  safeWriteFile,
  zeroBuffer,
} from "./encryption.js";
import { getDecryptedPrivateKeyPem, deriveUserId, type LedgerIdentity } from "./crypto.js";

// KEEP IN SYNC with packages/usrcp-cloud/src/rotate.ts ROTATE_ATTESTATION_DOMAIN.
const ROTATE_ATTESTATION_DOMAIN = "usrcp-rotate-v1";

// KEEP IN SYNC with packages/usrcp-cloud/src/auth.ts canonicalRequest/signRequest.
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

function attestRotation(oldPrivateKeyPem: string, newPublicKeyPem: string): string {
  const canon = Buffer.from(`${ROTATE_ATTESTATION_DOMAIN}\n${newPublicKeyPem}`, "utf8");
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(oldPrivateKeyPem));
  return sig.toString("base64url");
}

export interface RotateIdentityOpts {
  userDir: string;
  masterKey: Buffer;
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export interface RotateIdentityResult {
  old_public_key: string;
  new_public_key: string;
  new_user_id: string;
}

export async function rotateIdentity(opts: RotateIdentityOpts): Promise<RotateIdentityResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const keysDir = path.join(opts.userDir, "keys");
  const identityPath = path.join(keysDir, "identity.json");
  const privatePath = path.join(keysDir, "private.pem");
  const publicPath = path.join(keysDir, "public.pem");

  for (const p of [identityPath, privatePath, publicPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`rotateIdentity: missing required key file ${p}; ledger must be initialized first.`);
    }
  }

  const oldIdentity: LedgerIdentity = JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  const oldPublicPem = oldIdentity.public_key;
  const oldPrivatePem = getDecryptedPrivateKeyPem(opts.masterKey);

  // Generate fresh K2.
  const { publicKey: newPublicPem, privateKey: newPrivatePem } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const newUserId = deriveUserId(newPublicPem);

  // Sign the rotation attestation with the OLD private key over the
  // canonical "usrcp-rotate-v1\n<new_pub>" bytes.
  const rotationAttestation = attestRotation(oldPrivatePem, newPublicPem);

  // POST signed as K1.
  const body = {
    new_public_key: newPublicPem,
    rotation_attestation: rotationAttestation,
  };
  const bodyStr = JSON.stringify(body);
  const signed = signRequest(oldPrivatePem, "POST", "/v1/rotate-identity", bodyStr);
  const url = opts.endpoint.replace(/\/$/, "") + "/v1/rotate-identity";
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(oldPublicPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
    body: bodyStr,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status !== 200) {
    throw new Error(
      `rotateIdentity: cloud rejected rotation: HTTP ${res.status} ${JSON.stringify(json ?? null)}`
    );
  }

  // Cloud has rotated. Now persist the new identity locally. Snapshot
  // the prior files for rollback in case any local write fails.
  const priorIdentity = fs.readFileSync(identityPath);
  const priorPrivate = fs.readFileSync(privatePath);
  const priorPublic = fs.readFileSync(publicPath);
  const priorModes = {
    identity: fs.statSync(identityPath).mode & 0o7777,
    private: fs.statSync(privatePath).mode & 0o7777,
    public: fs.statSync(publicPath).mode & 0o7777,
  };

  const newIdentity: LedgerIdentity = {
    user_id: newUserId,
    public_key: newPublicPem,
    created_at: oldIdentity.created_at,
  };

  try {
    const globalKey = deriveGlobalEncryptionKey(opts.masterKey);
    let encryptedPriv: string;
    try {
      encryptedPriv = encrypt(newPrivatePem, globalKey);
    } finally {
      zeroBuffer(globalKey);
    }
    safeWriteFile(privatePath, Buffer.from(encryptedPriv, "utf8"), 0o600);
    safeWriteFile(publicPath, Buffer.from(newPublicPem, "utf8"), 0o644);
    safeWriteFile(
      identityPath,
      Buffer.from(JSON.stringify(newIdentity, null, 2), "utf8"),
      0o600
    );
  } catch (err) {
    // Roll local back. Cloud is already rotated; the user can use pair_join
    // from another device to recover. We surface a clear error pointing at
    // the recovery path.
    try { safeWriteFile(identityPath, priorIdentity, priorModes.identity); } catch { /* */ }
    try { safeWriteFile(privatePath, priorPrivate, priorModes.private); } catch { /* */ }
    try { safeWriteFile(publicPath, priorPublic, priorModes.public); } catch { /* */ }
    throw new Error(
      `rotateIdentity: cloud accepted rotation but local key write failed (${err instanceof Error ? err.message : String(err)}). ` +
      `The cloud now expects the new key; local files were rolled back. ` +
      `Recover by running 'usrcp pair join <code>' from a device that already holds the new identity.`
    );
  }

  return {
    old_public_key: oldPublicPem,
    new_public_key: newPublicPem,
    new_user_id: newUserId,
  };
}
