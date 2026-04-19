import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveGlobalEncryptionKey, encrypt, decrypt, isEncrypted } from "./encryption.js";

function getKeysDir(): string {
  return path.join(os.homedir(), ".usrcp", "keys");
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
 * Write file safely — prevents symlink attacks.
 * Writes to a temp file then renames atomically.
 * Rejects if the target path is a symlink.
 */
function safeWriteFile(filePath: string, content: string | Buffer | NodeJS.ArrayBufferView, mode: number): void {
  // Reject symlinks — prevents writing to arbitrary paths
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write: ${filePath} is a symlink`);
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    // File doesn't exist — safe to create
  }

  // Write to temp file in same directory, then rename (atomic on same filesystem)
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(8).toString("hex")}`);
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    if (typeof content === "string") {
      fs.writeSync(fd, content);
    } else {
      fs.writeSync(fd, content as Buffer);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
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
  safeWriteFile(privateKeyPath, encryptedPrivateKey, 0o600);
  safeWriteFile(publicKeyPath, keyPair.publicKey, 0o644);

  const identity: LedgerIdentity = {
    user_id,
    public_key: keyPair.publicKey,
    created_at: new Date().toISOString(),
  };

  safeWriteFile(identityPath, JSON.stringify(identity, null, 2), 0o600);

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
  safeWriteFile(privateKeyPath, encrypted, 0o600);
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

export function deriveDomainKey(
  masterSecret: string,
  domain: string
): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(masterSecret),
      Buffer.from(domain),
      Buffer.from("usrcp-domain-key-v1"),
      32
    )
  );
}
