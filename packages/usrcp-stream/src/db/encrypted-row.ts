import {
  encrypt as _encrypt,
  decrypt as _decrypt,
  isEncrypted as _isEncrypted,
  deriveDomainEncryptionKey as _deriveDomainEncryptionKey,
} from "usrcp-local/dist/encryption.js";

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
// run it on every column read/write — caching shaves it to one derivation
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
