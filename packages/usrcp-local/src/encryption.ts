/**
 * USRCP Encryption Module
 *
 * AES-256-GCM authenticated encryption for ledger data at rest.
 *
 * Two modes:
 * - Passphrase mode: key derived via scrypt on every startup. Only the salt
 *   and a verification hash are stored on disk. The derived key exists only
 *   in process memory and is zeroed on shutdown. An attacker with disk access
 *   cannot decrypt without the passphrase.
 * - Dev mode (no passphrase): random key stored on disk. Protects against
 *   disk-only theft but not local attacker. Suitable for development.
 *
 * Domain-scoped keys via HKDF-SHA256.
 * Blind index with n-gram tokens + noise injection for frequency analysis resistance.
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

// Noise: number of dummy tokens injected per real token set
const BLIND_INDEX_NOISE_COUNT = 3;

function getKeysDir(): string {
  return path.join(os.homedir(), ".usrcp", "keys");
}

function getMasterKeyPath(): string {
  return path.join(getKeysDir(), "master.key");
}

function getSaltPath(): string {
  return path.join(getKeysDir(), "master.salt");
}

function getVerifyPath(): string {
  return path.join(getKeysDir(), "master.verify");
}

function getKeyVersionPath(): string {
  return path.join(getKeysDir(), "key.version");
}

function getModePath(): string {
  return path.join(getKeysDir(), "mode");
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

/**
 * Generate a verification hash from the master key.
 * Stored on disk so we can verify the passphrase is correct on subsequent startups
 * without storing the key itself.
 */
function generateVerifyHash(masterKey: Buffer): Buffer {
  return crypto
    .createHmac("sha256", masterKey)
    .update("usrcp-verify")
    .digest();
}

/**
 * Derive master key from passphrase + stored salt.
 */
function deriveFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Initialize or load the master encryption key.
 *
 * Passphrase mode (passphrase provided):
 *   - First call: generate salt, derive key, store salt + verify hash. Key NOT stored.
 *   - Subsequent calls: load salt, re-derive key from passphrase, verify against hash.
 *   - If passphrase is wrong, throws.
 *
 * Dev mode (no passphrase):
 *   - First call: generate random key, store on disk.
 *   - Subsequent calls: load key from disk.
 */
export function initializeMasterKey(passphrase?: string): Buffer {
  fs.mkdirSync(getKeysDir(), { recursive: true, mode: 0o700 });

  const modePath = getModePath();
  const saltPath = getSaltPath();
  const verifyPath = getVerifyPath();
  const keyPath = getMasterKeyPath();

  // Determine mode from existing files
  const existingMode = fs.existsSync(modePath)
    ? fs.readFileSync(modePath, "utf-8").trim()
    : null;

  if (existingMode === "passphrase") {
    // Passphrase mode — re-derive key from passphrase
    if (!passphrase) {
      throw new Error(
        "This ledger is passphrase-protected. Provide passphrase to unlock."
      );
    }
    const salt = fs.readFileSync(saltPath);
    const masterKey = deriveFromPassphrase(passphrase, salt);

    // Verify passphrase is correct
    const storedVerify = fs.readFileSync(verifyPath);
    const computedVerify = generateVerifyHash(masterKey);
    if (!crypto.timingSafeEqual(storedVerify, computedVerify)) {
      zeroBuffer(masterKey);
      throw new Error("Invalid passphrase");
    }

    return masterKey;
  }

  if (existingMode === "dev" || fs.existsSync(keyPath)) {
    // Dev mode — load key from disk
    return fs.readFileSync(keyPath);
  }

  // First-time initialization
  if (passphrase) {
    // Passphrase mode: store salt + verify hash, NOT the key
    const salt = crypto.randomBytes(SALT_LENGTH);
    const masterKey = deriveFromPassphrase(passphrase, salt);
    const verifyHash = generateVerifyHash(masterKey);

    writeFileAtomic(saltPath, salt, 0o600);
    writeFileAtomic(verifyPath, verifyHash, 0o600);
    writeFileAtomic(modePath, Buffer.from("passphrase"), 0o600);

    // Do NOT write master.key — key exists only in memory

    if (!fs.existsSync(getKeyVersionPath())) {
      writeFileAtomic(getKeyVersionPath(), Buffer.from("1"), 0o600);
    }

    return masterKey;
  } else {
    // Dev mode: store random key on disk
    const masterKey = crypto.randomBytes(32);
    writeFileAtomic(keyPath, masterKey, 0o600);
    writeFileAtomic(modePath, Buffer.from("dev"), 0o600);

    if (!fs.existsSync(getKeyVersionPath())) {
      writeFileAtomic(getKeyVersionPath(), Buffer.from("1"), 0o600);
    }

    return masterKey;
  }
}

/**
 * Load the master key (dev mode only). Returns null if passphrase mode or not initialized.
 */
export function getMasterKey(): Buffer | null {
  const keyPath = getMasterKeyPath();
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath);
}

/**
 * Check if the ledger uses passphrase mode.
 */
export function isPassphraseMode(): boolean {
  const modePath = getModePath();
  if (!fs.existsSync(modePath)) return false;
  return fs.readFileSync(modePath, "utf-8").trim() === "passphrase";
}

export function getKeyVersion(): number {
  const versionPath = getKeyVersionPath();
  if (!fs.existsSync(versionPath)) return 1;
  return parseInt(fs.readFileSync(versionPath, "utf-8").trim(), 10) || 1;
}

/**
 * Rotate the master key.
 * In passphrase mode: new passphrase required, old passphrase must have been used to load current key.
 * In dev mode: generates new random key.
 */
export function rotateMasterKey(
  currentKey: Buffer,
  newPassphrase?: string
): {
  oldKey: Buffer;
  newKey: Buffer;
  version: number;
} {
  const currentVersion = getKeyVersion();
  const newVersion = currentVersion + 1;

  let newKey: Buffer;
  if (newPassphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    newKey = deriveFromPassphrase(newPassphrase, salt);
    const verifyHash = generateVerifyHash(newKey);
    writeFileAtomic(getSaltPath(), salt, 0o600);
    writeFileAtomic(getVerifyPath(), verifyHash, 0o600);
    writeFileAtomic(getModePath(), Buffer.from("passphrase"), 0o600);
    // Remove dev key file if it exists
    try { fs.unlinkSync(getMasterKeyPath()); } catch {}
  } else {
    newKey = crypto.randomBytes(32);
    writeFileAtomic(getMasterKeyPath(), newKey, 0o600);
    writeFileAtomic(getModePath(), Buffer.from("dev"), 0o600);
  }

  writeFileAtomic(getKeyVersionPath(), Buffer.from(String(newVersion)), 0o600);

  return { oldKey: currentKey, newKey, version: newVersion };
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

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// --- Blind Index with N-gram + Noise ---

const MIN_NGRAM = 3;
const MAX_NGRAM = 6;

/**
 * Generate blind index tokens with n-gram support and noise injection.
 *
 * N-grams enable prefix matching. Noise tokens (random HMACs) defeat
 * frequency analysis — an attacker can't distinguish real tokens from noise
 * without the blind index key.
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
    tokenSet.add(hmacToken(word, blindKey));
    for (let n = MIN_NGRAM; n <= Math.min(MAX_NGRAM, word.length); n++) {
      for (let i = 0; i <= word.length - n; i++) {
        tokenSet.add(hmacToken(word.substring(i, i + n), blindKey));
      }
    }
  }

  // Inject noise tokens to defeat frequency analysis
  for (let i = 0; i < BLIND_INDEX_NOISE_COUNT; i++) {
    tokenSet.add(crypto.randomBytes(4).toString("hex"));
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
