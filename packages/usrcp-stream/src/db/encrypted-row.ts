import {
  encrypt as _encrypt,
  decrypt as _decrypt,
  isEncrypted as _isEncrypted,
  deriveDomainEncryptionKey as _deriveDomainEncryptionKey,
} from "usrcp-local/encryption";

// Re-exported under test-only names so crypto-reuse.test.ts can assert by
// reference that we're calling usrcp-local's helpers rather than a local
// copy. If someone reimplements the crypto here, these references break.
export const _crypto = {
  encrypt: _encrypt,
  decrypt: _decrypt,
  isEncrypted: _isEncrypted,
  deriveDomainEncryptionKey: _deriveDomainEncryptionKey,
};

// HKDF domain names for every encrypted surface in stream.db. Each maps to
// `deriveDomainEncryptionKey(masterKey, <domain>)` which composes to a
// 32-byte key under HKDF salt `usrcp-domain-<domain>`. The `stream-` prefix
// keeps stream keys disjoint from any ledger domain.
const TABLE_DOMAINS = {
  events: "stream-events",
  threads: "stream-threads",
  surface_state: "stream-surface",
  config: "stream-config",
} as const;

export type EncryptedTable = keyof typeof TABLE_DOMAINS;

// Per-masterKey per-table derived-key cache. HKDF is cheap (~µs) but we
// run it on every column read/write - caching shaves it to one derivation
// per table per process. Lifetime ties to the master key buffer; rotation
// hands us a new buffer and the old cache becomes unreachable.
const keyCache = new WeakMap<Buffer, Map<EncryptedTable, Buffer>>();

function keyFor(masterKey: Buffer, table: EncryptedTable): Buffer {
  let inner = keyCache.get(masterKey);
  if (!inner) {
    inner = new Map();
    keyCache.set(masterKey, inner);
  }
  const cached = inner.get(table);
  if (cached) return cached;
  const key = _deriveDomainEncryptionKey(masterKey, TABLE_DOMAINS[table]);
  inner.set(table, key);
  return key;
}

export function encryptForColumn(
  masterKey: Buffer,
  table: EncryptedTable,
  plaintext: string
): string {
  return _encrypt(plaintext, keyFor(masterKey, table));
}

export function decryptFromColumn(
  masterKey: Buffer,
  table: EncryptedTable,
  ciphertext: string
): string {
  if (!_isEncrypted(ciphertext)) return ciphertext;
  return _decrypt(ciphertext, keyFor(masterKey, table));
}

export function encryptJsonForColumn(
  masterKey: Buffer,
  table: EncryptedTable,
  value: unknown
): string {
  return encryptForColumn(masterKey, table, JSON.stringify(value));
}

export function decryptJsonFromColumn<T = unknown>(
  masterKey: Buffer,
  table: EncryptedTable,
  ciphertext: string
): T {
  return JSON.parse(decryptFromColumn(masterKey, table, ciphertext)) as T;
}

// --- Embedding sync helpers ---
// Embeddings are stored RAW (float32 BLOB) in the local sqlite-vec
// index because the extension needs raw bytes. Cloud sync requires
// they leave the device encrypted, so on push we re-encrypt the raw
// vector under HKDF domain `stream-embeddings` (disjoint from
// stream-events / stream-threads / etc.) and on pull we decrypt back
// to raw float32 before inserting into the local index.
//
// Wire format: base64(raw float32 bytes) -> encrypt() -> "enc:<base64>"
// string. ~33% size overhead vs the raw blob, plus the 28-byte AES-GCM
// frame from encryption.ts.

const EMBEDDING_DOMAIN = "stream-embeddings";

const embeddingKeyCache = new WeakMap<Buffer, Buffer>();

function embeddingKey(masterKey: Buffer): Buffer {
  const cached = embeddingKeyCache.get(masterKey);
  if (cached) return cached;
  const key = _deriveDomainEncryptionKey(masterKey, EMBEDDING_DOMAIN);
  embeddingKeyCache.set(masterKey, key);
  return key;
}

export function encryptEmbeddingForSync(
  masterKey: Buffer,
  vec: Float32Array
): string {
  const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  return _encrypt(bytes.toString("base64"), embeddingKey(masterKey));
}

export function decryptEmbeddingFromSync(
  masterKey: Buffer,
  ciphertext: string
): Float32Array {
  const b64 = _decrypt(ciphertext, embeddingKey(masterKey));
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  );
}

// Convenience for the optional model name on a synced embedding row.
// The model string itself isn't load-bearing for crypto but encrypting
// it under the same domain keeps the wire format uniform and the
// server's `model_enc` opaque.
export function encryptEmbeddingModelForSync(
  masterKey: Buffer,
  model: string
): string {
  return _encrypt(model, embeddingKey(masterKey));
}

export function decryptEmbeddingModelFromSync(
  masterKey: Buffer,
  ciphertext: string
): string {
  return _decrypt(ciphertext, embeddingKey(masterKey));
}
