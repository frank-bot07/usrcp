/**
 * USRCP Encryption Module
 *
 * AES-256-GCM authenticated encryption for ledger data at rest.
 *
 * Two modes:
 * - Passphrase mode: key derived via scrypt on every startup. Only the salt
 *   and a verification hash are stored on disk. The derived key exists only
 *   in process memory and is zeroed on shutdown.
 * - Dev mode (no passphrase): random key stored on disk.
 *
 * Domain-scoped keys via HKDF-SHA256.
 * Blind index with n-gram tokens + noise injection.
 *
 * IMPORTANT: Buffer zeroing is applied to cryptographic material (keys, HMAC
 * digests) where it is effective. It is NOT applied to encrypt/decrypt output
 * after conversion to V8 strings, because V8 strings are immutable and cannot
 * be zeroed. This is a known limitation of the Node.js runtime.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = "enc:";
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const SCRYPT_KEYLEN = 32;
const SALT_LENGTH = 32;

// Blind index: 16 hex chars = 64 bits (was 8/32-bit — birthday collision fix)
const TOKEN_HEX_LENGTH = 16;

// Noise: dummy tokens per real token set
const BLIND_INDEX_NOISE_COUNT = 3;

// --- User scope (for multi-user on one machine) ---
//
// The current user slug selects which subdirectory of ~/.usrcp/users/
// holds keys, ledger, and identity files. Default slug is "default" so
// the single-user case works unchanged after migration.

const USER_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
let currentUserSlug: string = "default";

export function setUserSlug(slug: string): void {
  if (!USER_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid user slug "${slug}" — must be lowercase alphanumeric, ` +
      `underscore, or hyphen; 1-63 chars; must start with alphanumeric.`
    );
  }
  currentUserSlug = slug;
}

export function getUserSlug(): string {
  return currentUserSlug;
}

export function getUsrcpBaseDir(): string {
  return path.join(os.homedir(), ".usrcp");
}

export function getUserDir(): string {
  return path.join(getUsrcpBaseDir(), "users", currentUserSlug);
}

export function listUserSlugs(): string[] {
  const usersDir = path.join(getUsrcpBaseDir(), "users");
  if (!fs.existsSync(usersDir)) return [];
  return fs
    .readdirSync(usersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && USER_SLUG_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

function getKeysDir(): string {
  return path.join(getUserDir(), "keys");
}

/**
 * Migrate a pre-v0.2 single-user layout to the v0.2 multi-user layout.
 *
 * Detects files directly under ~/.usrcp (ledger.db, keys/, mode, etc.)
 * and moves them into ~/.usrcp/users/default/. Leaves a MIGRATED.md
 * breadcrumb so the migration is not attempted again.
 *
 * No-op if:
 * - ~/.usrcp does not exist (fresh install)
 * - ~/.usrcp/users/ already exists (already migrated)
 * - ~/.usrcp/MIGRATED.md exists (previous migration breadcrumb)
 */
export function migrateLegacyLayout(): { migrated: boolean; movedPaths: string[] } {
  const base = getUsrcpBaseDir();
  if (!fs.existsSync(base)) return { migrated: false, movedPaths: [] };

  const usersDir = path.join(base, "users");
  const breadcrumb = path.join(base, "MIGRATED.md");
  if (fs.existsSync(usersDir) || fs.existsSync(breadcrumb)) {
    return { migrated: false, movedPaths: [] };
  }

  // Things we know about from the v0.1 layout that should move
  const candidates = [
    "ledger.db",
    "ledger.db-wal",
    "ledger.db-shm",
    "keys",
  ];

  const existing = candidates.filter((c) => fs.existsSync(path.join(base, c)));
  if (existing.length === 0) return { migrated: false, movedPaths: [] };

  const defaultDir = path.join(usersDir, "default");
  fs.mkdirSync(defaultDir, { recursive: true, mode: 0o700 });

  const moved: string[] = [];
  for (const name of existing) {
    const src = path.join(base, name);
    const dst = path.join(defaultDir, name);
    fs.renameSync(src, dst);
    moved.push(name);
  }

  fs.writeFileSync(
    breadcrumb,
    `# USRCP migrated to multi-user layout\n\n` +
    `Timestamp: ${new Date().toISOString()}\n\n` +
    `Files previously under ~/.usrcp/ were moved into ~/.usrcp/users/default/ ` +
    `to support multiple ledgers on one machine.\n\n` +
    `Moved: ${moved.join(", ")}\n\n` +
    `Run \`usrcp status\` or \`usrcp serve --user=default\` — behavior is unchanged.\n`,
    { mode: 0o644 }
  );

  return { migrated: true, movedPaths: moved };
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

/**
 * Write file safely — prevents symlink TOCTOU attacks.
 * Writes to a temp file with O_EXCL then renames atomically.
 */
export function safeWriteFile(filePath: string, content: Buffer, mode: number): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write: ${filePath} is a symlink`);
    }
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }

  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp_${crypto.randomBytes(8).toString("hex")}`);
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * fsync a file's data + inode to disk. Used at durability boundaries
 * (pair-join key-file writes) where SIGKILL safety alone is not
 * enough: a power loss between the write returning and the kernel
 * flushing buffer-cache could lose the data. On POSIX (Darwin/Linux)
 * this issues fsync(2); on filesystems / platforms where fsync is
 * not supported the open or fsync call may fail, which we swallow:
 * the rename is still atomic in the SIGKILL sense, just not
 * durable past a kernel-level crash.
 */
export function fsyncFile(filePath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Best-effort: see jsdoc.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* swallow */ }
    }
  }
}

/**
 * fsync a directory so its entry list (added/removed/renamed files)
 * is durably on disk. POSIX-only; on Windows or filesystems that
 * reject opening a directory for reading this is a no-op. Used at
 * the rename boundaries in pair-join so that a power loss after a
 * rename returns successfully does not leave the parent directory
 * with a stale view of which children exist.
 */
export function fsyncDir(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch {
    // Best-effort: see jsdoc.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* swallow */ }
    }
  }
}

/**
 * mkdir -p with full power-loss durability for the entire newly-
 * created chain. mkdirSync({ recursive: true }) is itself crash-
 * safe, but each newly-created directory's existence is recorded
 * only in its parent's inode - which can be lost across power
 * failure before the kernel flushes the parent. Without an fsync
 * walk, a fresh-install pair-join that creates the full
 * `~/.usrcp/users/<slug>/` chain risks losing one or more chain
 * links across a power loss after the join returns.
 *
 * Resolution: after mkdirSync, if anything was created, walk from
 * the topmost newly-created directory down to the target, fsyncing
 * each parent along the way. mkdirSync(recursive:true) returns the
 * path of the topmost dir it had to create (or undefined when
 * everything already existed; the chain was already durable from
 * prior runs and no extra work is needed).
 */
export function mkdirpDurable(target: string, mode: number): void {
  const firstCreated = fs.mkdirSync(target, { recursive: true, mode });
  if (!firstCreated) return;
  let cursor = firstCreated;
  while (true) {
    // fsync the parent of `cursor` so cursor's entry is durable
    // in its parent. cursor itself may not be fully durable yet
    // (its own children's entries become durable on the next
    // iteration when we fsync `cursor` as the parent of the next
    // child).
    fsyncDir(path.dirname(cursor));
    if (cursor === target) break;
    // Descend one path component toward target.
    const rest = target.slice(cursor.length).replace(/^[\\/]/, "");
    if (!rest) break;
    const nextComponent = rest.split(/[\\/]/)[0];
    if (!nextComponent) break;
    cursor = path.join(cursor, nextComponent);
  }
}

function generateVerifyHash(masterKey: Buffer): Buffer {
  return crypto
    .createHmac("sha256", masterKey)
    .update("usrcp-verify")
    .digest();
}

function deriveFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 512 * 1024 * 1024,  // 512 MB — 128*N*r*p needs ~256 MB; Node default is 32 MB
  });
}

/**
 * Pure in-memory passphrase validation against a (salt, verify) pair.
 *
 * pairJoin uses this to validate the user's passphrase against the
 * bundle's stored salt+verify BEFORE writing any key files to disk.
 * Without it, a wrong passphrase would write all six key files first
 * and only catch the mismatch when initializeMasterKey() ran against
 * the now-canonical files - leaving partial state on disk if the
 * process was killed before the snapshot-restore rollback completed.
 *
 * Returns the derived master key on success. Throws "Invalid
 * passphrase" on mismatch; caller wraps as WrongPassphrase. The
 * caller is responsible for zeroing the returned Buffer.
 */
export function deriveAndVerifyMasterKey(
  passphrase: string,
  salt: Buffer,
  expectedVerify: Buffer
): Buffer {
  const masterKey = deriveFromPassphrase(passphrase, salt);
  const computed = generateVerifyHash(masterKey);
  if (
    expectedVerify.length !== computed.length ||
    !crypto.timingSafeEqual(expectedVerify, computed)
  ) {
    zeroBuffer(masterKey);
    throw new Error("Invalid passphrase");
  }
  return masterKey;
}

// Fixed personalization salt for the legacy (v1) pairing KDF where the
// 8-digit code was BOTH the lookup key sent to the server AND the scrypt
// input. v2 (deriveFromPairingSecret below) replaces this design so the
// cloud no longer holds the decryption material; v1 is retained only for
// schema_v=1 bundle compatibility during the rollout window.
export const FIXED_PAIRING_SALT: Buffer = Buffer.from(
  "usrcp-pairing-v1-fixed-salt-32by", // 32 bytes ASCII
  "utf8"
);

export function deriveFromPairingCode(code: string): Buffer {
  return deriveFromPassphrase(code, FIXED_PAIRING_SALT);
}

// v2 KDF: the 16-byte `secret` is the actual encryption material and
// never reaches the server; `code` is the 8-digit lookup key sent to
// /v1/pairing/init only. HKDF stretches the 128-bit secret to 256 bits
// and uses the code as a salt so the same secret would yield a
// different key under a different code (defense if a client RNG ever
// regenerates the secret). Output: 32 bytes for AES-256-GCM.
const PAIRING_HKDF_INFO = Buffer.from("usrcp-pairing-v2", "utf8");
export function deriveFromPairingSecret(code: string, secret: Buffer): Buffer {
  if (secret.length !== 16) {
    throw new Error(
      `deriveFromPairingSecret: secret must be 16 bytes, got ${secret.length}`
    );
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      secret,
      Buffer.from(code, "utf8"),
      PAIRING_HKDF_INFO,
      32
    )
  );
}

export function initializeMasterKey(passphrase?: string): Buffer {
  fs.mkdirSync(getKeysDir(), { recursive: true, mode: 0o700 });

  const modePath = getModePath();
  const saltPath = getSaltPath();
  const verifyPath = getVerifyPath();
  const keyPath = getMasterKeyPath();

  const existingMode = fs.existsSync(modePath)
    ? fs.readFileSync(modePath, "utf-8").trim()
    : null;

  if (existingMode === "passphrase") {
    if (!passphrase) {
      throw new Error(
        "This ledger is passphrase-protected. Provide passphrase to unlock."
      );
    }
    const salt = fs.readFileSync(saltPath);
    const masterKey = deriveFromPassphrase(passphrase, salt);

    const storedVerify = fs.readFileSync(verifyPath);
    const computedVerify = generateVerifyHash(masterKey);
    if (storedVerify.length !== computedVerify.length || !crypto.timingSafeEqual(storedVerify, computedVerify)) {
      zeroBuffer(masterKey);
      throw new Error("Invalid passphrase");
    }

    return masterKey;
  }

  if (existingMode === "dev" || fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  if (passphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const masterKey = deriveFromPassphrase(passphrase, salt);
    const verifyHash = generateVerifyHash(masterKey);

    safeWriteFile(saltPath, salt, 0o600);
    safeWriteFile(verifyPath, verifyHash, 0o600);
    safeWriteFile(modePath, Buffer.from("passphrase"), 0o600);

    if (!fs.existsSync(getKeyVersionPath())) {
      safeWriteFile(getKeyVersionPath(), Buffer.from("1"), 0o600);
    }

    return masterKey;
  } else {
    const masterKey = crypto.randomBytes(32);
    safeWriteFile(keyPath, masterKey, 0o600);
    safeWriteFile(modePath, Buffer.from("dev"), 0o600);

    if (!fs.existsSync(getKeyVersionPath())) {
      safeWriteFile(getKeyVersionPath(), Buffer.from("1"), 0o600);
    }

    return masterKey;
  }
}

export function getMasterKey(): Buffer | null {
  const keyPath = getMasterKeyPath();
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath);
}

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
 *
 * CRITICAL: This function returns the new key and version but does NOT
 * write the new salt/verify/mode to disk. The caller (Ledger.rotateKey)
 * must call commitKeyRotation() AFTER the database re-encryption transaction
 * succeeds. This prevents the bricked-DB race condition where a crash
 * between key file write and DB re-encryption leaves the DB unreadable.
 */
export function prepareKeyRotation(
  currentKey: Buffer,
  newPassphrase?: string
): {
  oldKey: Buffer;
  newKey: Buffer;
  version: number;
  pendingFiles: { path: string; content: Buffer; mode: number }[];
} {
  const currentVersion = getKeyVersion();
  const newVersion = currentVersion + 1;
  const pendingFiles: { path: string; content: Buffer; mode: number }[] = [];

  let newKey: Buffer;
  if (newPassphrase) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    newKey = deriveFromPassphrase(newPassphrase, salt);
    const verifyHash = generateVerifyHash(newKey);
    pendingFiles.push({ path: getSaltPath(), content: salt, mode: 0o600 });
    pendingFiles.push({ path: getVerifyPath(), content: verifyHash, mode: 0o600 });
    pendingFiles.push({ path: getModePath(), content: Buffer.from("passphrase"), mode: 0o600 });
    // Queue removal of dev key
    pendingFiles.push({ path: getMasterKeyPath(), content: Buffer.alloc(0), mode: 0o600 });
  } else {
    newKey = crypto.randomBytes(32);
    pendingFiles.push({ path: getMasterKeyPath(), content: newKey, mode: 0o600 });
    pendingFiles.push({ path: getModePath(), content: Buffer.from("dev"), mode: 0o600 });
  }

  pendingFiles.push({
    path: getKeyVersionPath(),
    content: Buffer.from(String(newVersion)),
    mode: 0o600,
  });

  return { oldKey: currentKey, newKey, version: newVersion, pendingFiles };
}

/**
 * Commit key rotation files to disk.
 * Called ONLY after database re-encryption succeeds.
 *
 * Power-loss durability: each file write is fsync'd before the next
 * one runs, and the set of parent directories touched is fsync'd
 * once at the end. Without this, the rotateKey path was atomic in
 * the SIGKILL sense (the existing rotation_state.pending_key
 * recovery handles partial commit) but not durable: a power loss
 * after rotateKey returned could leave the new key files
 * un-flushed and the next boot could read stale master.salt /
 * master.verify pointing at the OLD master key, breaking
 * decryption of data already re-encrypted under the new key.
 * Same shape as pair-join's fsync discipline in PR #71.
 */
export function commitKeyRotation(
  pendingFiles: { path: string; content: Buffer; mode: number }[]
): void {
  const parentDirs = new Set<string>();
  for (const file of pendingFiles) {
    if (file.content.length === 0) {
      // Delete the file (e.g., removing dev key in passphrase mode).
      try { fs.unlinkSync(file.path); } catch {}
    } else {
      safeWriteFile(file.path, file.content, file.mode);
      fsyncFile(file.path);
    }
    parentDirs.add(path.dirname(file.path));
  }
  // fsync every directory we touched so the new entries (or the
  // unlink of the old dev-key file) are durably linked.
  for (const dir of parentDirs) {
    fsyncDir(dir);
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
  const updateBuf = cipher.update(plaintext, "utf8");
  const finalBuf = cipher.final();
  const encrypted = Buffer.concat([updateBuf, finalBuf]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, encrypted, tag]);
  const result = ENCRYPTED_PREFIX + packed.toString("base64");

  // Zero cryptographic intermediate Buffers (effective — these are Buffer objects)
  // NOTE: The returned `result` is a V8 string and CANNOT be zeroed.
  zeroBuffer(updateBuf);
  zeroBuffer(finalBuf);
  zeroBuffer(encrypted);
  zeroBuffer(packed);

  return result;
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
  const updateBuf = decipher.update(ciphertext);
  const finalBuf = decipher.final();
  const decrypted = Buffer.concat([updateBuf, finalBuf]);
  const result = decrypted.toString("utf8");

  // Zero the Buffer forms (effective). The V8 string `result` cannot be zeroed.
  zeroBuffer(decrypted);
  zeroBuffer(updateBuf);
  zeroBuffer(finalBuf);
  zeroBuffer(packed);

  return result;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// --- Blind Index with N-gram + Noise ---

const MIN_NGRAM = 3;
const MAX_NGRAM = 6;

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

  // Noise tokens use same length as real tokens to be indistinguishable
  for (let i = 0; i < BLIND_INDEX_NOISE_COUNT; i++) {
    tokenSet.add(crypto.randomBytes(TOKEN_HEX_LENGTH / 2).toString("hex"));
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
  const digest = hmac.digest();
  const token = digest.toString("hex").slice(0, TOKEN_HEX_LENGTH);
  zeroBuffer(digest); // Zero cryptographic material (effective on Buffer)
  return token;
}

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
