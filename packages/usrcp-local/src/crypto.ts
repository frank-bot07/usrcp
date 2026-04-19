import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
 * Write a file atomically with correct permissions.
 * Opens with O_WRONLY | O_CREAT | O_EXCL to avoid TOCTOU race,
 * then writes content. File is created with the specified mode from the start.
 */
function writeFileAtomic(
  filePath: string,
  content: string,
  mode: number
): void {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, mode);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

export function initializeIdentity(): LedgerIdentity {
  ensureKeysDir();

  const identityPath = path.join(getKeysDir(), "identity.json");
  const privateKeyPath = path.join(getKeysDir(), "private.pem");
  const publicKeyPath = path.join(getKeysDir(), "public.pem");

  if (fs.existsSync(identityPath)) {
    return JSON.parse(fs.readFileSync(identityPath, "utf-8"));
  }

  const keyPair = generateKeyPair();
  const user_id = deriveUserId(keyPair.publicKey);

  // Write private key with restrictive permissions atomically
  writeFileAtomic(privateKeyPath, keyPair.privateKey, 0o600);
  writeFileAtomic(publicKeyPath, keyPair.publicKey, 0o644);

  const identity: LedgerIdentity = {
    user_id,
    public_key: keyPair.publicKey,
    created_at: new Date().toISOString(),
  };

  writeFileAtomic(identityPath, JSON.stringify(identity, null, 2), 0o600);

  return identity;
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
