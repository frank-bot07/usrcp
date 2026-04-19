import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function getKeysDir(): string {
  return path.join(process.env.HOME || "~", ".usrcp", "keys");
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
  fs.mkdirSync(getKeysDir(), { recursive: true });
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

  fs.writeFileSync(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
  fs.writeFileSync(publicKeyPath, keyPair.publicKey, { mode: 0o644 });

  const identity: LedgerIdentity = {
    user_id,
    public_key: keyPair.publicKey,
    created_at: new Date().toISOString(),
  };

  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });

  return identity;
}

export function getIdentity(): LedgerIdentity | null {
  const identityPath = path.join(getKeysDir(), "identity.json");
  if (!fs.existsSync(identityPath)) return null;
  return JSON.parse(fs.readFileSync(identityPath, "utf-8"));
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
