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

  // Encrypt K2's private key under the SAME master key, then BACK IT UP
  // to a sidecar file BEFORE the cloud call. This makes K2 durable on
  // disk regardless of how the rest of this function ends: if a later
  // local write fails (disk full, permissions, interrupted SIGKILL),
  // the user still has a copy of K2's encrypted private key and can
  // recover by hand. Rolling K1 back over the canonical private.pem
  // after a successful cloud rotation would lock the user out of their
  // own data, so we never do that.
  const globalKey = deriveGlobalEncryptionKey(opts.masterKey);
  let encryptedPriv: string;
  try {
    encryptedPriv = encrypt(newPrivatePem, globalKey);
  } finally {
    zeroBuffer(globalKey);
  }

  const backupTs = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(keysDir, `private.pem.rotated-${backupTs}.bak`);
  safeWriteFile(backupPath, Buffer.from(encryptedPriv, "utf8"), 0o600);

  const newIdentity: LedgerIdentity = {
    user_id: newUserId,
    public_key: newPublicPem,
    created_at: oldIdentity.created_at,
  };

  // POST signed as K1.
  const body = {
    new_public_key: newPublicPem,
    rotation_attestation: rotationAttestation,
  };
  const bodyStr = JSON.stringify(body);
  const signed = signRequest(oldPrivatePem, "POST", "/v1/rotate-identity", bodyStr);
  const url = opts.endpoint.replace(/\/$/, "") + "/v1/rotate-identity";

  // Three exit states for the cloud call:
  //   - DEFINITE_ACCEPT: cloud returned 200. Replace local files in-place.
  //   - DEFINITE_REJECT: cloud returned 4xx (auth/validation/conflict).
  //     Nothing rotated server-side; delete the backup.
  //   - AMBIGUOUS: the cloud may or may not have committed (network drop
  //     after the request reached the server, 5xx that could be
  //     post-commit, etc.). Keep the backup so the user can verify and
  //     finish manually or rerun safely.
  let outcome: "ACCEPT" | "REJECT" | "AMBIGUOUS" = "AMBIGUOUS";
  let cloudErrSummary = "network error";
  try {
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
    if (res.status === 200) {
      outcome = "ACCEPT";
    } else if (res.status >= 400 && res.status < 500) {
      // 4xx is a definite server-side rejection (e.g. BAD_ATTESTATION,
      // NEW_KEY_IN_USE, KEY_REVOKED). The cloud did NOT commit.
      outcome = "REJECT";
      cloudErrSummary = `HTTP ${res.status} ${JSON.stringify(json ?? null)}`;
    } else {
      // 5xx or other unexpected status: the cloud may have committed the
      // rotation before erroring (write made it but the response did not).
      // Treat as ambiguous.
      outcome = "AMBIGUOUS";
      cloudErrSummary = `HTTP ${res.status} ${JSON.stringify(json ?? null)}`;
    }
  } catch (err) {
    // The fetch threw (DNS, TCP reset, abort, etc). The request may have
    // reached the server and committed before the connection dropped.
    outcome = "AMBIGUOUS";
    cloudErrSummary = err instanceof Error ? err.message : String(err);
  }

  if (outcome === "REJECT") {
    // Cloud definitely rejected. Nothing rotated server-side; remove the
    // sidecar - we don't need a recovery copy.
    try { fs.unlinkSync(backupPath); } catch { /* */ }
    throw new Error(`rotateIdentity: cloud rejected rotation: ${cloudErrSummary}`);
  }

  if (outcome === "AMBIGUOUS") {
    // Cloud state unknown. Leave the K2 backup in place. If the rotation
    // committed server-side, K2's private key survives at backupPath and
    // the user can finish the local side manually. If it didn't, no harm:
    // the backup is just an unused encrypted file.
    throw new Error(
      `rotateIdentity: cloud state UNKNOWN after rotation request (${cloudErrSummary}). ` +
      `K2's encrypted private key has been preserved at ${backupPath} in case the cloud committed. ` +
      `Check with 'usrcp status' or by signing a probe request from both K1 and K2 - whichever ` +
      `returns 200 is your current identity. If K2 is now authoritative, copy ${backupPath} to ` +
      `${privatePath} and write the new public.pem + identity.json as documented in the rotate-identity ` +
      `error path. If K1 is still authoritative, delete ${backupPath} and try again.`
    );
  }

  // outcome === "ACCEPT": cloud accepted. Replace the canonical key files
  // in place. The backup remains as K2's durable copy until every
  // canonical write succeeds.
  try {
    safeWriteFile(privatePath, Buffer.from(encryptedPriv, "utf8"), 0o600);
    safeWriteFile(publicPath, Buffer.from(newPublicPem, "utf8"), 0o644);
    safeWriteFile(
      identityPath,
      Buffer.from(JSON.stringify(newIdentity, null, 2), "utf8"),
      0o600
    );
    // All canonical writes succeeded; the backup is no longer needed.
    try { fs.unlinkSync(backupPath); } catch { /* */ }
  } catch (err) {
    // Cloud accepted but a canonical local write failed. Leave the
    // backup AND any partial in-place writes alone, and surface the
    // exact path of the backup so the user can recover by hand.
    throw new Error(
      `rotateIdentity: cloud accepted rotation but the local write failed (${err instanceof Error ? err.message : String(err)}). ` +
      `K2's encrypted private key has been preserved at ${backupPath}. ` +
      `Copy it to ${privatePath} (mode 0600), write the new public key to ${publicPath} ` +
      `(${newPublicPem.length} bytes, see the network response), then write identity.json with ` +
      `{"user_id":"${newUserId}","public_key":"<the new PEM>","created_at":"${oldIdentity.created_at}"}. ` +
      `Until that is done, this device cannot sign requests as the new identity.`
    );
  }

  return {
    old_public_key: oldPublicPem,
    new_public_key: newPublicPem,
    new_user_id: newUserId,
  };
}
