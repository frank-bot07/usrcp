import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  encrypt,
  decrypt,
  isEncrypted,
  deriveDomainEncryptionKey,
  deriveBlindIndexKey,
  generateBlindTokens,
  generateSearchTokens,
  initializeMasterKey,
  getMasterKey,
  zeroBuffer,
  prepareKeyRotation,
  commitKeyRotation,
} from "../encryption.js";
import { Ledger } from "../ledger/index.js";

describe("AES-256-GCM encrypt/decrypt", () => {
  const key = crypto.randomBytes(32);

  it("encrypts and decrypts a string roundtrip", () => {
    const plaintext = "sensitive user data: therapy session notes";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypted value starts with enc: prefix", () => {
    const encrypted = encrypt("hello", key);
    expect(encrypted.startsWith("enc:")).toBe(true);
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const e1 = encrypt("same input", key);
    const e2 = encrypt("same input", key);
    expect(e1).not.toBe(e2); // Different IVs
    // But both decrypt to same value
    expect(decrypt(e1, key)).toBe("same input");
    expect(decrypt(e2, key)).toBe("same input");
  });

  it("detects tampering (GCM auth tag)", () => {
    const encrypted = encrypt("hello", key);
    // Flip a byte in the ciphertext
    const parts = encrypted.split(":");
    const buf = Buffer.from(parts[1], "base64");
    buf[buf.length - 5] ^= 0xff; // Corrupt auth tag area
    const tampered = "enc:" + buf.toString("base64");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("fails with wrong key", () => {
    const wrongKey = crypto.randomBytes(32);
    const encrypted = encrypt("secret", key);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("passes through non-encrypted values (backward compat)", () => {
    const plain = '{"key": "value"}';
    const result = decrypt(plain, key);
    expect(result).toBe(plain);
  });

  it("handles empty string", () => {
    const encrypted = encrypt("", key);
    expect(decrypt(encrypted, key)).toBe("");
  });

  it("handles large payloads", () => {
    const large = "x".repeat(100000);
    const encrypted = encrypt(large, key);
    expect(decrypt(encrypted, key)).toBe(large);
  });

  it("rejects truncated ciphertext", () => {
    expect(() => decrypt("enc:AAAA", key)).toThrow("Encrypted value too short");
  });
});

describe("isEncrypted", () => {
  it("identifies encrypted values", () => {
    expect(isEncrypted("enc:base64data")).toBe(true);
    expect(isEncrypted('{"plain": "json"}')).toBe(false);
    expect(isEncrypted("[]")).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });
});

describe("Domain key derivation", () => {
  const masterKey = crypto.randomBytes(32);

  it("derives different keys for different domains", () => {
    const k1 = deriveDomainEncryptionKey(masterKey, "coding");
    const k2 = deriveDomainEncryptionKey(masterKey, "health");
    expect(k1.equals(k2)).toBe(false);
  });

  it("is deterministic", () => {
    const k1 = deriveDomainEncryptionKey(masterKey, "coding");
    const k2 = deriveDomainEncryptionKey(masterKey, "coding");
    expect(k1.equals(k2)).toBe(true);
  });

  it("blind index key differs from encryption key", () => {
    const encKey = deriveDomainEncryptionKey(masterKey, "coding");
    const blindKey = deriveBlindIndexKey(masterKey, "coding");
    expect(encKey.equals(blindKey)).toBe(false);
  });

  it("data encrypted with coding key cannot be decrypted with health key", () => {
    const codingKey = deriveDomainEncryptionKey(masterKey, "coding");
    const healthKey = deriveDomainEncryptionKey(masterKey, "health");
    const encrypted = encrypt("therapy notes", codingKey);
    expect(() => decrypt(encrypted, healthKey)).toThrow();
  });
});

describe("Blind index tokens", () => {
  const key = crypto.randomBytes(32);

  it("generates tokens from text", () => {
    const tokens = generateBlindTokens("fixed authentication bug", key);
    expect(tokens.length).toBeGreaterThan(0);
    // Each token is 16 hex chars (64 bits — birthday collision resistant)
    tokens.forEach((t) => expect(t).toMatch(/^[0-9a-f]{16}$/));
  });

  it("generates deterministic real tokens (noise differs)", () => {
    const t1 = generateBlindTokens("authentication", key);
    const t2 = generateBlindTokens("authentication", key);
    // Noise tokens are random, but real tokens should overlap
    const overlap = t1.filter((t) => t2.includes(t));
    // At least the real tokens (word + n-grams) should be consistent
    expect(overlap.length).toBeGreaterThan(5);
  });

  it("search tokens match stored tokens", () => {
    const stored = generateBlindTokens(
      "fixed authentication middleware bug",
      key
    );
    const search = generateSearchTokens("authentication", key);
    // The search token for "authentication" should appear in stored tokens
    expect(stored).toContain(search[0]);
  });

  it("different keys produce different tokens", () => {
    const key2 = crypto.randomBytes(32);
    const t1 = generateBlindTokens("hello", key);
    const t2 = generateBlindTokens("hello", key2);
    expect(t1).not.toEqual(t2);
  });

  it("strips punctuation and deduplicates", () => {
    const tokens = generateBlindTokens("hello, hello! world.", key);
    // "hello" appears twice but should be deduplicated
    const unique = [...new Set(tokens)];
    expect(tokens.length).toBe(unique.length);
  });

  it("skips single-character words", () => {
    const tokens = generateBlindTokens("a b cd ef", key);
    // "a" and "b" skipped, "cd" and "ef" tokenized (2 word tokens) + 3 noise = 5
    expect(tokens.length).toBe(5);
  });
});

describe("Master key management", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-enc-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("generates and persists a 32-byte master key", () => {
    // Need keys dir to exist
    fs.mkdirSync(path.join(tmpHome, ".usrcp", "keys"), { recursive: true });
    const key = initializeMasterKey();
    expect(key.length).toBe(32);

    // Persists across calls
    const key2 = initializeMasterKey();
    expect(key.equals(key2)).toBe(true);
  });

  it("returns null from getMasterKey before init", () => {
    const key = getMasterKey();
    expect(key).toBeNull();
  });
});

describe("zeroBuffer", () => {
  it("fills buffer with zeros", () => {
    const buf = Buffer.from("sensitive data");
    zeroBuffer(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });
});

describe("Encryption integration with Ledger", () => {
  let ledger: Ledger;
  let dbPath: string;
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-enc-ledger-"));
    process.env.HOME = tmpHome;
    dbPath = path.join(tmpHome, "test.db");
    ledger = new Ledger(dbPath);
  });

  afterEach(() => {
    ledger.close();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("encrypts detail field at rest", () => {
    ledger.appendEvent(
      {
        domain: "health",
        summary: "Therapy session",
        intent: "Mental health",
        outcome: "success",
        detail: { therapist: "Dr. Smith", notes: "Discussed anxiety" },
      },
      "therapy_bot"
    );

    // Read raw database — detail should be encrypted
    const rawDb = new Database(dbPath, { readonly: true });
    const row = rawDb.prepare("SELECT detail FROM timeline_events LIMIT 1").get() as any;
    rawDb.close();

    expect(row.detail.startsWith("enc:")).toBe(true);
    expect(row.detail).not.toContain("Dr. Smith");
    expect(row.detail).not.toContain("anxiety");

    // But ledger returns decrypted data
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].detail).toEqual({
      therapist: "Dr. Smith",
      notes: "Discussed anxiety",
    });
  });

  it("encrypts tags at rest", () => {
    ledger.appendEvent(
      {
        domain: "health",
        summary: "Session",
        intent: "test",
        outcome: "success",
        tags: ["anxiety", "therapy", "confidential"],
      },
      "test"
    );

    const rawDb = new Database(dbPath, { readonly: true });
    const row = rawDb.prepare("SELECT tags FROM timeline_events LIMIT 1").get() as any;
    rawDb.close();

    expect(row.tags.startsWith("enc:")).toBe(true);
    expect(row.tags).not.toContain("anxiety");
  });

  it("encrypts domain context at rest", () => {
    ledger.upsertDomainContext("health", {
      condition: "anxiety disorder",
      medication: "sertraline",
    });

    const rawDb = new Database(dbPath, { readonly: true });
    const row = rawDb.prepare("SELECT context FROM domain_context LIMIT 1").get() as any;
    rawDb.close();

    expect(row.context.startsWith("enc:")).toBe(true);
    expect(row.context).not.toContain("sertraline");

    // But ledger returns decrypted
    const ctx = ledger.getDomainContext(["health"]);
    expect(ctx.health.medication).toBe("sertraline");
  });

  it("domain isolation: schemaless facts cannot be decrypted with wrong domain key", () => {
    ledger.setFact("health", "meds", "daily", "sertraline 50mg");

    const rawDb = new Database(dbPath, { readonly: true });
    const row = rawDb
      .prepare("SELECT namespace, \"key\", value, domain FROM schemaless_facts LIMIT 1")
      .get() as any;
    rawDb.close();

    expect(row.namespace.startsWith("enc:")).toBe(true);
    expect(row.value.startsWith("enc:")).toBe(true);

    const masterKey = getMasterKey()!;
    const wrongKey = deriveDomainEncryptionKey(masterKey, "coding");
    expect(() => decrypt(row.value, wrongKey)).toThrow();

    const rightKey = deriveDomainEncryptionKey(masterKey, "health");
    expect(decrypt(row.value, rightKey)).toContain("sertraline");
  });

  it("domain isolation: coding key cannot decrypt health data", () => {
    ledger.appendEvent(
      {
        domain: "health",
        summary: "Health event",
        intent: "test",
        outcome: "success",
        detail: { secret: "classified" },
      },
      "test"
    );

    // Read raw encrypted value
    const rawDb = new Database(dbPath, { readonly: true });
    const row = rawDb.prepare("SELECT detail, domain FROM timeline_events LIMIT 1").get() as any;
    rawDb.close();

    // Try to decrypt with wrong domain key
    const masterKey = getMasterKey()!;
    const wrongKey = deriveDomainEncryptionKey(masterKey, "coding");
    expect(() => decrypt(row.detail, wrongKey)).toThrow();

    // Correct domain key works
    const rightKey = deriveDomainEncryptionKey(masterKey, "health");
    const decrypted = decrypt(row.detail, rightKey);
    expect(decrypted).toContain("classified");
  });
});

describe("Key Rotation (encryption module)", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-rotation-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("prepareKeyRotation generates new key and pending files", () => {
    // Need keys dir to exist for getKeyVersion
    fs.mkdirSync(path.join(tmpHome, ".usrcp", "keys"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".usrcp", "keys", "key.version"), "1");

    const oldKey = crypto.randomBytes(32);
    const { newKey, version, pendingFiles } = prepareKeyRotation(oldKey);
    expect(newKey.length).toBe(32);
    expect(version).toBe(2);
    // pendingFiles is an array of {path, content, mode}
    expect(Array.isArray(pendingFiles)).toBe(true);
    expect(pendingFiles.length).toBeGreaterThan(0);
    // Should include a master.key file
    const keyFile = pendingFiles.find((f) => f.path.endsWith("master.key"));
    expect(keyFile).toBeDefined();
    expect(keyFile!.content.length).toBe(32);
  });

  it("commitKeyRotation writes pending files to disk", () => {
    const keysDir = path.join(tmpHome, ".usrcp", "keys");
    fs.mkdirSync(keysDir, { recursive: true });

    const pendingFiles = [
      { path: path.join(keysDir, "master.key"), content: Buffer.from("test-key-data-32-bytes-exactly!!"), mode: 0o600 },
      { path: path.join(keysDir, "key.version"), content: Buffer.from("2"), mode: 0o600 },
    ];

    commitKeyRotation(pendingFiles);

    expect(fs.existsSync(path.join(keysDir, "master.key"))).toBe(true);
    const written = fs.readFileSync(path.join(keysDir, "master.key"));
    expect(written.toString()).toBe("test-key-data-32-bytes-exactly!!");
  });
});

describe("passphrase mode initialization", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-scrypt-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("does not throw RangeError on scrypt memory limit with default Node maxmem", () => {
    // Regression: with N=131072, r=8, p=2 scrypt needs ~256 MB (128*N*r*p).
    // Node's default maxmem is 32 MB, so without explicit maxmem this throws.
    expect(() => {
      const key = initializeMasterKey("test-passphrase-some-words");
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    }).not.toThrow();
  });

  it("derives the same master key for the same passphrase + salt", () => {
    const key1 = initializeMasterKey("repeatable-passphrase");
    const key2 = initializeMasterKey("repeatable-passphrase");
    expect(key1.equals(key2)).toBe(true);
  });
});
