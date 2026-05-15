import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  initializeMasterKey,
  setUserSlug,
  deriveGlobalEncryptionKey,
  deriveDomainEncryptionKey,
  deriveBlindIndexKey,
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

// Codex P0-2: frozen HKDF test vectors. If anyone changes the HKDF info
// string, the salt prefix (e.g. usrcp-domain-* or usrcp-global), or the
// derivation algorithm, these byte values change and these tests fail
// loudly. The earlier test only compared two paths to each other, which
// silently passed when both were changed in lockstep.
//
// Master key for these vectors is bytes 0..31. To regenerate, run:
//   node -e "const e=require('usrcp-local/dist/encryption.js'); ..."
// from inside packages/usrcp-stream/ where the import resolves.
const FROZEN_MASTER_KEY = (() => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = i;
  return buf;
})();

const FROZEN_VECTORS = {
  global: "58e0efa7caaa73af36f577ae3026864540074e739892be1c0987fc5a4bb41ff8",
  events: "a223acaa50b06dd03e0bf5a6544f4ed32a9fcb74d0575d9976b21f2f08f91a48",
  threads: "5c2668a19aae57e26f2b04fe0b2118e0ea98f038e0c9291efced48ebc3325dba",
  surface: "5f77913de6974f46d9872dc4474f7688caedb36579596200555970dfabce42f8",
  config: "5974e85e93140b09a101d2b4559fcf58ded0ae0cd832349f47c10171ada0a417",
  blindEvents: "2bfc835f5379411ba8409bc706a1a3c440ac006d47ff9542040c41280f525902",
} as const;

describe("frozen HKDF vectors (Codex P0-2)", () => {
  it("deriveGlobalEncryptionKey matches the frozen vector", () => {
    expect(deriveGlobalEncryptionKey(FROZEN_MASTER_KEY).toString("hex")).toBe(
      FROZEN_VECTORS.global
    );
  });

  it("deriveDomainEncryptionKey(stream-events) matches the frozen vector", () => {
    expect(
      deriveDomainEncryptionKey(FROZEN_MASTER_KEY, "stream-events").toString("hex")
    ).toBe(FROZEN_VECTORS.events);
  });

  it("deriveDomainEncryptionKey(stream-threads) matches the frozen vector", () => {
    expect(
      deriveDomainEncryptionKey(FROZEN_MASTER_KEY, "stream-threads").toString("hex")
    ).toBe(FROZEN_VECTORS.threads);
  });

  it("deriveDomainEncryptionKey(stream-surface) matches the frozen vector", () => {
    expect(
      deriveDomainEncryptionKey(FROZEN_MASTER_KEY, "stream-surface").toString("hex")
    ).toBe(FROZEN_VECTORS.surface);
  });

  it("deriveDomainEncryptionKey(stream-config) matches the frozen vector", () => {
    expect(
      deriveDomainEncryptionKey(FROZEN_MASTER_KEY, "stream-config").toString("hex")
    ).toBe(FROZEN_VECTORS.config);
  });

  it("deriveBlindIndexKey(stream-events) matches the frozen vector", () => {
    expect(
      deriveBlindIndexKey(FROZEN_MASTER_KEY, "stream-events").toString("hex")
    ).toBe(FROZEN_VECTORS.blindEvents);
  });

  it("derived keys are 32 bytes (HKDF-SHA256 width)", () => {
    expect(deriveGlobalEncryptionKey(FROZEN_MASTER_KEY).length).toBe(32);
    expect(deriveDomainEncryptionKey(FROZEN_MASTER_KEY, "any").length).toBe(32);
    expect(deriveBlindIndexKey(FROZEN_MASTER_KEY, "any").length).toBe(32);
  });
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
