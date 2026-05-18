import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveGlobalEncryptionKey, encrypt, decrypt, isEncrypted, getUserDir, safeWriteFile, zeroBuffer, type PendingKeyFile } from "./encryption.js";

function getKeysDir(): string {
  return path.join(getUserDir(), "keys");
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface LedgerIdentity {
  user_id: string;
  public_key: string;
  created_at: string;
}

export function ensureKeysDir(): void {
  fs.mkdirSync(getKeysDir(), { recursive: true, mode: 0o700 });
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function deriveUserId(publicKey: string): string {
  const hash = crypto.createHash("sha256").update(publicKey).digest("hex");
  return `u_${hash.slice(0, 16)}`;
}

/**
 * Initialize identity with encrypted private key storage.
 * masterKey is REQUIRED — the private key is encrypted before the first
 * byte hits disk. There is no plaintext window and no temp key.
 */
export function initializeIdentity(masterKey: Buffer): LedgerIdentity {
  ensureKeysDir();

  const identityPath = path.join(getKeysDir(), "identity.json");
  const privateKeyPath = path.join(getKeysDir(), "private.pem");
  const publicKeyPath = path.join(getKeysDir(), "public.pem");

  if (fs.existsSync(identityPath)) {
    return JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  }

  const keyPair = generateKeyPair();
  const user_id = deriveUserId(keyPair.publicKey);

  // Encrypt private key with the real master key BEFORE writing to disk
  const globalKey = deriveGlobalEncryptionKey(masterKey);
  const encryptedPrivateKey = encrypt(keyPair.privateKey, globalKey);
  safeWriteFile(privateKeyPath, Buffer.from(encryptedPrivateKey, "utf8"), 0o600);
  safeWriteFile(publicKeyPath, Buffer.from(keyPair.publicKey, "utf8"), 0o644);

  const identity: LedgerIdentity = {
    user_id,
    public_key: keyPair.publicKey,
    created_at: new Date().toISOString(),
  };

  safeWriteFile(identityPath, Buffer.from(JSON.stringify(identity, null, 2), "utf8"), 0o600);

  return identity;
}

/**
 * Re-encrypt the private key if it's still in plaintext.
 * Called after master key is available.
 */
export function ensurePrivateKeyEncrypted(masterKey: Buffer): void {
  const privateKeyPath = path.join(getKeysDir(), "private.pem");
  if (!fs.existsSync(privateKeyPath)) return;

  const content = fs.readFileSync(privateKeyPath, "utf-8");
  if (isEncrypted(content)) return; // Already encrypted

  // Encrypt and overwrite
  const globalKey = deriveGlobalEncryptionKey(masterKey);
  const encrypted = encrypt(content, globalKey);
  safeWriteFile(privateKeyPath, Buffer.from(encrypted, "utf8"), 0o600);
}

export function getIdentity(): LedgerIdentity | null {
  const identityPath = path.join(getKeysDir(), "identity.json");
  if (!fs.existsSync(identityPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Re-encrypt private.pem under a new master key as part of a
 * rotateKey commit. Returns a PendingKeyFile entry the caller
 * appends to the rotation's pendingFiles array; commitKeyRotation
 * then writes it durably alongside the master.salt / master.verify
 * / mode / key.version entries.
 *
 * Pre-this-helper, rotateKey rotated the DB rows AND the master-
 * key file set but left private.pem sealed under the OLD globalKey.
 * Any subsequent getDecryptedPrivateKeyPem(newMasterKey) would fail
 * (GCM auth tag mismatch) - effectively erasing the Ed25519
 * identity used for cloud-sync signing.
 *
 * Returns null when:
 *   - private.pem doesn't exist (no identity yet)
 *   - private.pem is plaintext (legacy pre-v0.1.3) - the next
 *     ensurePrivateKeyEncrypted() will pick it up under the new key
 */
export function prepareReencryptedPrivatePem(
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): PendingKeyFile | null {
  const privPath = path.join(getKeysDir(), "private.pem");
  if (!fs.existsSync(privPath)) return null;
  const content = fs.readFileSync(privPath, "utf-8");
  if (!isEncrypted(content)) return null;

  const oldGlobalKey = deriveGlobalEncryptionKey(oldMasterKey);
  const newGlobalKey = deriveGlobalEncryptionKey(newMasterKey);
  try {
    let plain: string;
    try {
      plain = decrypt(content, oldGlobalKey);
    } catch (err) {
      // private.pem on disk was sealed under a DIFFERENT master
      // key than the one rotateKey is rotating away from. The most
      // common cause is a ledger whose identity is already
      // orphaned from a prior incomplete rotation (the latent bug
      // this helper was added to prevent going forward). Log so
      // the operator can recover the identity by re-running
      // `usrcp setup` or by pairing from another device, but do
      // NOT block the data-rotation - the DB rows still need to
      // re-encrypt successfully, and stale private.pem is no worse
      // post-rotation than pre-rotation.
      console.warn(
        `[usrcp] rotateKey: private.pem did not decrypt under the current master key (${
          err instanceof Error ? err.message : String(err)
        }). Skipping re-encryption; the identity may already be orphaned. Re-run \`usrcp setup\` or pair from another device to restore.`
      );
      return null;
    }
    const reencrypted = encrypt(plain, newGlobalKey);
    return {
      path: privPath,
      content: Buffer.from(reencrypted, "utf-8"),
      mode: 0o600,
    };
  } finally {
    zeroBuffer(oldGlobalKey);
    zeroBuffer(newGlobalKey);
  }
}

/**
 * Decrypt the user's stored Ed25519 private key. Requires the master key
 * (same key that encrypted it at init). Returns PEM. Caller is responsible
 * for not logging or persisting the result.
 */
export function getDecryptedPrivateKeyPem(masterKey: Buffer): string {
  const privPath = path.join(getKeysDir(), "private.pem");
  if (!fs.existsSync(privPath)) {
    throw new Error("Private key not found — has the ledger been initialized?");
  }
  const content = fs.readFileSync(privPath, "utf-8");
  if (!isEncrypted(content)) {
    // Legacy plaintext (pre-v0.1.3) — encrypt on next write via ensurePrivateKeyEncrypted
    return content;
  }
  const globalKey = deriveGlobalEncryptionKey(masterKey);
  const plain = decrypt(content, globalKey);
  // Zero the derived key; can't zero the string
  globalKey.fill(0);
  return plain;
}

