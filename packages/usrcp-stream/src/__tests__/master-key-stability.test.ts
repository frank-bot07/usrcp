import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initializeMasterKey,
  setUserSlug,
} from "usrcp-local/dist/encryption.js";
import { Ledger } from "usrcp-local/dist/ledger/index.js";

// Proves that a user can switch between unified mode (running through
// `usrcp serve`, which constructs a Ledger) and standalone stream mode
// (which initializes the master key on its own) without re-encrypting any
// data. The key bytes must match.

let tmpHome: string;
let origHome: string | undefined;
let dbPath: string;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-key-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  dbPath = path.join(tmpHome, "ledger.db");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("master-key stability across unified <-> standalone", () => {
  it("dev mode: Ledger writes master.key; standalone reads identical bytes", () => {
    const ledger = new Ledger(dbPath);
    const keyA = Buffer.from(ledger.getMasterKey());
    ledger.close();

    const keyB = initializeMasterKey();
    expect(keyA.length).toBe(32);
    expect(keyB.length).toBe(32);
    expect(Buffer.compare(keyA, keyB)).toBe(0);
  });

  it("passphrase mode: same passphrase + on-disk salt produces identical keys", () => {
    const passphrase = "correct-horse-battery-staple-test-only";

    const ledger = new Ledger(dbPath, passphrase);
    const keyA = Buffer.from(ledger.getMasterKey());
    ledger.close();

    const keyB = initializeMasterKey(passphrase);
    expect(keyA.length).toBe(32);
    expect(keyB.length).toBe(32);
    expect(Buffer.compare(keyA, keyB)).toBe(0);
  }, 30_000);

  it("passphrase mode: wrong passphrase on the second call throws", () => {
    const passphrase = "correct-horse-battery-staple-test-only";

    const ledger = new Ledger(dbPath, passphrase);
    ledger.close();

    expect(() => initializeMasterKey("wrong-passphrase")).toThrow(/Invalid passphrase/);
  }, 30_000);
});
