import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateKeyPair,
  deriveUserId,
  deriveDomainKey,
  initializeIdentity,
  getIdentity,
} from "../crypto.js";

describe("generateKeyPair", () => {
  it("returns PEM-encoded Ed25519 keys", () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(kp.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("generates unique keys each time", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});

describe("deriveUserId", () => {
  it("returns a deterministic user_id from a public key", () => {
    const kp = generateKeyPair();
    const id1 = deriveUserId(kp.publicKey);
    const id2 = deriveUserId(kp.publicKey);
    expect(id1).toBe(id2);
  });

  it("starts with u_ prefix", () => {
    const kp = generateKeyPair();
    const id = deriveUserId(kp.publicKey);
    expect(id).toMatch(/^u_[0-9a-f]{16}$/);
  });

  it("produces different IDs for different keys", () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    expect(deriveUserId(kp1.publicKey)).not.toBe(deriveUserId(kp2.publicKey));
  });
});

describe("deriveDomainKey", () => {
  it("returns a 32-byte buffer", () => {
    const key = deriveDomainKey("master-secret", "coding");
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("is deterministic", () => {
    const k1 = deriveDomainKey("secret", "coding");
    const k2 = deriveDomainKey("secret", "coding");
    expect(k1.equals(k2)).toBe(true);
  });

  it("produces different keys for different domains", () => {
    const k1 = deriveDomainKey("secret", "coding");
    const k2 = deriveDomainKey("secret", "health");
    expect(k1.equals(k2)).toBe(false);
  });

  it("produces different keys for different secrets", () => {
    const k1 = deriveDomainKey("secret1", "coding");
    const k2 = deriveDomainKey("secret2", "coding");
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("initializeIdentity / getIdentity", () => {
  let origHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-test-home-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("creates identity on first call", () => {
    const identity = initializeIdentity();
    expect(identity.user_id).toMatch(/^u_[0-9a-f]{16}$/);
    expect(identity.public_key).toContain("BEGIN PUBLIC KEY");
    expect(identity.created_at).toBeTruthy();
  });

  it("returns same identity on subsequent calls", () => {
    const id1 = initializeIdentity();
    const id2 = initializeIdentity();
    expect(id1.user_id).toBe(id2.user_id);
    expect(id1.created_at).toBe(id2.created_at);
  });

  it("creates key files on disk", () => {
    initializeIdentity();
    const keysDir = path.join(tmpHome, ".usrcp", "keys");
    expect(fs.existsSync(path.join(keysDir, "identity.json"))).toBe(true);
    expect(fs.existsSync(path.join(keysDir, "private.pem"))).toBe(true);
    expect(fs.existsSync(path.join(keysDir, "public.pem"))).toBe(true);
  });

  it("getIdentity returns null before init", () => {
    const identity = getIdentity();
    expect(identity).toBeNull();
  });

  it("getIdentity returns identity after init", () => {
    initializeIdentity();
    const identity = getIdentity();
    expect(identity).not.toBeNull();
    expect(identity!.user_id).toMatch(/^u_/);
  });
});
