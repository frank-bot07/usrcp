import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import {
  setUserSlug,
  getUserSlug,
  getUserDir,
  listUserSlugs,
  migrateLegacyLayout,
  initializeMasterKey,
  deriveDomainEncryptionKey,
  decrypt,
} from "../encryption.js";
import { Ledger } from "../ledger/index.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-multiuser-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default"); // reset between tests
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("User slug validation", () => {
  it("accepts valid slugs", () => {
    for (const slug of ["default", "frank", "user_1", "a-b-c", "abc123"]) {
      expect(() => setUserSlug(slug)).not.toThrow();
      expect(getUserSlug()).toBe(slug);
    }
  });

  it("rejects invalid slugs", () => {
    const bad = ["", "Frank", "-leading", "1_but_ok", "a/b", "with space", "x".repeat(64), "_underscore_start"];
    for (const slug of bad) {
      if (slug === "1_but_ok") continue; // digits at start are OK per the regex
      expect(() => setUserSlug(slug)).toThrow(/Invalid user slug/);
    }
  });
});

describe("Multi-user cryptographic isolation", () => {
  // These tests use dev mode (no passphrase). Scrypt parameters in production
  // (N=131072) require ~128MB which exceeds Node's default maxmem in a test
  // process; isolation is structurally identical — each user gets an
  // independent random master key under their own keys/ dir.

  it("two users' master keys are different and stored separately", () => {
    setUserSlug("alice");
    const aliceKey = initializeMasterKey();
    const alicePath = path.join(getUserDir(), "keys", "master.key");
    expect(fs.existsSync(alicePath)).toBe(true);

    setUserSlug("bob");
    const bobKey = initializeMasterKey();
    const bobPath = path.join(getUserDir(), "keys", "master.key");
    expect(fs.existsSync(bobPath)).toBe(true);

    expect(alicePath).not.toBe(bobPath);
    expect(Buffer.compare(aliceKey, bobKey)).not.toBe(0);
  });

  it("user A's key cannot decrypt user B's ciphertext", () => {
    setUserSlug("alice");
    const aliceKey = initializeMasterKey();
    const alicePath = path.join(getUserDir(), "ledger.db");
    fs.mkdirSync(path.dirname(alicePath), { recursive: true });
    const aliceLedger = new Ledger(alicePath);
    aliceLedger.setFact("personal", "secret", "pin", "ALICE-1234");
    aliceLedger.close();

    setUserSlug("bob");
    const bobKey = initializeMasterKey();
    const bobPath = path.join(getUserDir(), "ledger.db");
    fs.mkdirSync(path.dirname(bobPath), { recursive: true });
    const bobLedger = new Ledger(bobPath);
    bobLedger.setFact("personal", "secret", "pin", "BOB-9999");
    bobLedger.close();

    const rawAlice = new Database(alicePath, { readonly: true });
    const aliceRow = rawAlice
      .prepare("SELECT value FROM schemaless_facts LIMIT 1")
      .get() as any;
    rawAlice.close();

    const wrongKey = deriveDomainEncryptionKey(bobKey, "personal");
    expect(() => decrypt(aliceRow.value, wrongKey)).toThrow();

    const rightKey = deriveDomainEncryptionKey(aliceKey, "personal");
    expect(decrypt(aliceRow.value, rightKey)).toContain("ALICE-1234");
  });

  it("listUserSlugs returns only directories matching the slug regex", () => {
    setUserSlug("alice");
    initializeMasterKey();
    setUserSlug("bob");
    initializeMasterKey();

    // Create a bogus entry with capitals — must be filtered out
    const bogus = path.join(tmpHome, ".usrcp", "users", "Bad-Name");
    fs.mkdirSync(bogus, { recursive: true });

    const slugs = listUserSlugs();
    expect(slugs).toContain("alice");
    expect(slugs).toContain("bob");
    expect(slugs).not.toContain("Bad-Name");
  });
});

describe("Legacy layout migration", () => {
  it("no-op when ~/.usrcp doesn't exist", () => {
    const result = migrateLegacyLayout();
    expect(result.migrated).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".usrcp"))).toBe(false);
  });

  it("no-op when already migrated (users/ exists)", () => {
    const usersDir = path.join(tmpHome, ".usrcp", "users", "default");
    fs.mkdirSync(usersDir, { recursive: true });
    const result = migrateLegacyLayout();
    expect(result.migrated).toBe(false);
  });

  it("moves legacy ledger.db and keys/ into users/default/", () => {
    const base = path.join(tmpHome, ".usrcp");
    const legacyKeys = path.join(base, "keys");
    fs.mkdirSync(legacyKeys, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyKeys, "master.salt"), "fake-salt");
    fs.writeFileSync(path.join(legacyKeys, "master.verify"), "fake-verify");
    fs.writeFileSync(path.join(legacyKeys, "mode"), "passphrase");
    fs.writeFileSync(path.join(base, "ledger.db"), "fake-db");

    const result = migrateLegacyLayout();
    expect(result.migrated).toBe(true);
    expect(result.movedPaths.sort()).toEqual(["keys", "ledger.db"].sort());

    const newBase = path.join(base, "users", "default");
    expect(fs.existsSync(path.join(newBase, "ledger.db"))).toBe(true);
    expect(fs.existsSync(path.join(newBase, "keys", "master.salt"))).toBe(true);
    expect(fs.existsSync(path.join(newBase, "keys", "mode"))).toBe(true);

    // Old paths gone
    expect(fs.existsSync(path.join(base, "ledger.db"))).toBe(false);
    expect(fs.existsSync(path.join(base, "keys"))).toBe(false);

    // Breadcrumb present
    expect(fs.existsSync(path.join(base, "MIGRATED.md"))).toBe(true);
  });

  it("migration is idempotent — running twice is safe", () => {
    const base = path.join(tmpHome, ".usrcp");
    const legacyKeys = path.join(base, "keys");
    fs.mkdirSync(legacyKeys, { recursive: true });
    fs.writeFileSync(path.join(legacyKeys, "master.salt"), "x");
    fs.writeFileSync(path.join(base, "ledger.db"), "y");

    const first = migrateLegacyLayout();
    expect(first.migrated).toBe(true);

    const second = migrateLegacyLayout();
    expect(second.migrated).toBe(false);
    expect(second.movedPaths).toEqual([]);
  });

  it("after migration, the dev-mode master.key is still readable", () => {
    // Simulate: legacy install had dev-mode keys under ~/.usrcp/keys/
    setUserSlug("default");
    const origKey = initializeMasterKey(); // creates files in users/default/keys/

    // Move those files to the legacy location (simulating a pre-v0.2 install)
    const base = path.join(tmpHome, ".usrcp");
    const usersDir = path.join(base, "users");
    fs.renameSync(path.join(usersDir, "default", "keys"), path.join(base, "keys"));
    fs.rmdirSync(path.join(usersDir, "default"));
    fs.rmdirSync(usersDir);

    const result = migrateLegacyLayout();
    expect(result.migrated).toBe(true);

    // Re-read the master.key — must match the original (same bytes, new path)
    const recoveredKey = initializeMasterKey();
    expect(Buffer.compare(recoveredKey, origKey)).toBe(0);
  });
});
