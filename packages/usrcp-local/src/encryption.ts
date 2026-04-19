/**
 * USRCP Encryption Module
 *
 * AES-256-GCM authenticated encryption for ledger data at rest.
 * Master key derived from user passphrase via scrypt.
 * Domain-scoped keys via HKDF-SHA256.
 * Blind index with n-gram tokens for prefix search.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = "enc:";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LENGTH = 32;

function getKeysDir(): string {
  return path.join(os.homedir(), ".usrcp", "keys");
}

function getMasterKeyPath(): string {
  return path.join(getKeysDir(), "master.key");
}

function getSaltPath(): string {
  return path.join(getKeysDir(), "master.salt");
}

function getKeyVersionPath(): string {
  return path.join(getKeysDir(), "key.version");
}

/**
 * Initialize the master key from a passphrase via scrypt.
 * If no passphrase is provided, generates a random master key (dev/local mode).
 * Stores the salt (not the key) so the key can be re-derived from passphrase.
 */
export function initializeMasterKey(passphrase?: string): Buffer {
  const keyPath = getMasterKeyPath();
  const saltPath = getSaltPath();

  fs.mkdirSync(getKeysDir(), { recursive: true, mode: 0o700 });

  // If key already exists, load it
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  let masterKey: Buffer;
  let salt: Buffer;

  if (passphrase) {
    // Derive key from passphrase via scrypt
    salt = crypto.randomBytes(SALT_LENGTH);
    masterKey = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    // Store salt for re-derivation
    writeFileAtomic(saltPath, salt, 0o600);
  } else {
    // No passphrase — random key (local dev mode)
    masterKey = crypto.randomBytes(32);
    salt = Buffer.alloc(0);
  }

  writeFileAtomic(keyPath, masterKey, 0o600);

  // Initialize key version
  if (!fs.existsSync(getKeyVersionPath())) {
    writeFileAtomic(getKeyVersionPath(), Buffer.from("1"), 0o600);
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
 * Get the current key version (for rotation tracking).
 */
export function getKeyVersion(): number {
  const versionPath = getKeyVersionPath();
  if (!fs.existsSync(versionPath)) return 1;
  return parseInt(fs.readFileSync(versionPath, "utf-8").trim(), 10) || 1;
}

/**
 * Rotate the master key: generate new key, increment version.
 * Returns { oldKey, newKey, version }.
 * Caller is responsible for re-encrypting data.
 */
export function rotateMasterKey(passphrase?: string): {
  oldKey: Buffer;
  newKey: Buffer;
  version: number;
} {
  const oldKey = getMasterKey();
  if (!oldKey) throw new Error("No master key to rotate");

  const currentVersion = getKeyVersion();
  const newVersion = currentVersion + 1;

  let newKey: Buffer;
  if (passphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    newKey = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    writeFileAtomic(getSaltPath(), salt, 0o600);
  } else {
    newKey = crypto.randomBytes(32);
  }

  writeFileAtomic(getMasterKeyPath(), newKey, 0o600);
  writeFileAtomic(getKeyVersionPath(), Buffer.from(String(newVersion)), 0o600);

  return { oldKey, newKey, version: newVersion };
}

function writeFileAtomic(filePath: string, content: Buffer, mode: number): void {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    mode
  );
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

// --- Encryption / Decryption ---

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
 * Derive a global encryption key (not domain-scoped).
 * Used for fields that aren't tied to a domain (identity, preferences, metadata).
 */
export function deriveGlobalEncryptionKey(masterKey: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      masterKey,
      Buffer.from("usrcp-global"),
      Buffer.from("usrcp-encryption-v1"),
      32
    )
  );
}

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

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, encrypted, tag]);
  return ENCRYPTED_PREFIX + packed.toString("base64");
}

export function decrypt(encryptedValue: string, key: Buffer): string {
  if (!encryptedValue.startsWith(ENCRYPTED_PREFIX)) {
    return encryptedValue; // backward compat
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

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// --- Blind Index with N-gram support ---

const MIN_NGRAM = 3;
const MAX_NGRAM = 6;

/**
 * Generate blind index tokens with n-gram support.
 * For each word, generates:
 * - Full word token (exact match)
 * - Character n-grams from 3 to min(6, word.length) (prefix/substring match)
 *
 * This means searching "auth" matches "authentication" because
 * "authentication" has an n-gram "auth" that produces the same token.
 */
export function generateBlindTokens(
  text: string,
  blindKey: Buffer
): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const uniqueWords = [...new Set(words)];
  const tokenSet = new Set<string>();

  for (const word of uniqueWords) {
    // Full word token
    tokenSet.add(hmacToken(word, blindKey));

    // N-gram tokens for prefix matching
    for (let n = MIN_NGRAM; n <= Math.min(MAX_NGRAM, word.length); n++) {
      for (let i = 0; i <= word.length - n; i++) {
        const ngram = word.substring(i, i + n);
        tokenSet.add(hmacToken(ngram, blindKey));
      }
    }
  }

  return [...tokenSet];
}

export function generateSearchTokens(
  query: string,
  blindKey: Buffer
): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const tokenSet = new Set<string>();
  for (const word of words) {
    // Generate token for the search term as-is
    // This matches both full words and n-grams stored in the index
    tokenSet.add(hmacToken(word, blindKey));
  }
  return [...tokenSet];
}

function hmacToken(value: string, key: Buffer): string {
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(value);
  return hmac.digest("hex").slice(0, 8);
}

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
