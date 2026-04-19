/**
 * USRCP Encryption Module
 *
 * AES-256-GCM authenticated encryption for ledger data at rest.
 * Each encrypted field uses a random 12-byte IV and produces a
 * 16-byte authentication tag. Format: base64(iv + ciphertext + tag)
 *
 * Key derivation uses HKDF-SHA256 from the user's master key,
 * scoped by domain name. This ensures domain isolation — a key
 * derived for "coding" cannot decrypt "health" data.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const TAG_LENGTH = 16; // GCM auth tag length
const ENCRYPTED_PREFIX = "enc:"; // Prefix to identify encrypted values

function getMasterKeyPath(): string {
  return path.join(os.homedir(), ".usrcp", "keys", "master.key");
}

/**
 * Initialize or load the master encryption key.
 * Stored as 32 random bytes in ~/.usrcp/keys/master.key with 0o600 permissions.
 */
export function initializeMasterKey(): Buffer {
  const keyPath = getMasterKeyPath();

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const masterKey = crypto.randomBytes(32);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  // Atomic write with restrictive permissions
  const fd = fs.openSync(
    keyPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600
  );
  try {
    fs.writeSync(fd, masterKey);
  } finally {
    fs.closeSync(fd);
  }

  return masterKey;
}

/**
 * Load the master key. Returns null if not initialized.
 */
export function getMasterKey(): Buffer | null {
  const keyPath = getMasterKeyPath();
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath);
}

/**
 * Derive a domain-scoped encryption key using HKDF-SHA256.
 * Same master key + different domain → different encryption key.
 */
export function deriveDomainEncryptionKey(
  masterKey: Buffer,
  domain: string
): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(`usrcp-domain-${domain}`),
      Buffer.from("usrcp-encryption-v1"),
      32
    )
  );
}

/**
 * Derive a key for blind index tokens (used for encrypted search).
 * Separate from the encryption key so compromising search tokens
 * doesn't expose plaintext.
 */
export function deriveBlindIndexKey(
  masterKey: Buffer,
  domain: string
): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(`usrcp-blind-${domain}`),
      Buffer.from("usrcp-blind-index-v1"),
      32
    )
  );
}

/**
 * Encrypt a string value using AES-256-GCM.
 * Returns: "enc:" + base64(iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: IV (12) + ciphertext (variable) + tag (16)
  const packed = Buffer.concat([iv, encrypted, tag]);
  return ENCRYPTED_PREFIX + packed.toString("base64");
}

/**
 * Decrypt a value produced by encrypt().
 * Returns the plaintext string.
 * Throws on tampered data (GCM auth tag verification failure).
 */
export function decrypt(encryptedValue: string, key: Buffer): string {
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    // Not encrypted — return as-is (backward compatibility)
    return encryptedValue;
  }

  const packed = Buffer.from(
    encryptedValue.slice(ENCRYPTED_PREFIX.length),
    "base64"
  );

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted value too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Check if a value is encrypted (has the enc: prefix).
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Generate blind index tokens for searchable encryption.
 * Splits text into words, HMAC-SHA256 each word with the blind index key,
 * returns truncated hex tokens that can be stored and searched.
 *
 * This allows exact word matching on encrypted data without exposing plaintext.
 * Tokens are truncated to 8 hex chars (32 bits) — sufficient for search
 * with low collision probability at typical dataset sizes.
 */
export function generateBlindTokens(
  text: string,
  blindKey: Buffer
): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1); // Skip single chars

  const uniqueWords = [...new Set(words)];

  return uniqueWords.map((word) => {
    const hmac = crypto.createHmac("sha256", blindKey);
    hmac.update(word);
    return hmac.digest("hex").slice(0, 8);
  });
}

/**
 * Generate blind tokens for a search query.
 * Returns tokens that can be matched against stored blind index tokens.
 */
export function generateSearchTokens(
  query: string,
  blindKey: Buffer
): string[] {
  return generateBlindTokens(query, blindKey);
}

/**
 * Securely zero a buffer to prevent memory residue.
 */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
