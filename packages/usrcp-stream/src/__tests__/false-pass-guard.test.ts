import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import * as encryption from "usrcp-local/dist/encryption.js";
import { encryptForColumn, decryptFromColumn } from "../db/encrypted-row.js";

// Build-prompt §11.10 false-pass trap: if the encryption layer is broken
// (a no-op encrypt, an identity-function cipher, or any drift that strips
// the "enc:" envelope), the suite must FAIL — not pass for the wrong
// reason like PR #24 did.
//
// We can't monkey-patch ESM exports (their bindings are read-only), so
// instead we exercise every load-bearing property of encrypt/decrypt
// directly. If any of these fail, the broader suite's encrypted-rows
// and crypto-reuse tests also fail, closing the gap.

describe("false-pass guard", () => {
  it("encrypt(plaintext) does not return plaintext", () => {
    const key = crypto.randomBytes(32);
    const plaintext = "this must remain encrypted XYZZY-needle";
    const ct = encryption.encrypt(plaintext, encryption.deriveDomainEncryptionKey(key, "x"));
    expect(ct).not.toBe(plaintext);
    expect(ct.includes(plaintext)).toBe(false);
  });

  it("ciphertext always starts with 'enc:' — a missing prefix is a regression", () => {
    const key = crypto.randomBytes(32);
    const ct = encryptForColumn(key, "events", "anything");
    expect(ct).toMatch(/^enc:/);
  });

  it("encrypt is non-deterministic across calls (a fresh IV per call)", () => {
    const key = crypto.randomBytes(32);
    const a = encryptForColumn(key, "events", "same input");
    const b = encryptForColumn(key, "events", "same input");
    expect(a).not.toBe(b);
  });

  it("decrypt(encrypt(x)) === x roundtrips losslessly", () => {
    const key = crypto.randomBytes(32);
    const x = "✓ unicode survives 漢字 𝓒 emoji 🔐";
    expect(decryptFromColumn(key, "events", encryptForColumn(key, "events", x))).toBe(x);
  });

  it("decryptFromColumn with the WRONG key throws — proves the key gates access", () => {
    const k1 = crypto.randomBytes(32);
    const k2 = crypto.randomBytes(32);
    const ct = encryptForColumn(k1, "events", "secret");
    expect(() => decryptFromColumn(k2, "events", ct)).toThrow();
  });

  it("decryptFromColumn with the WRONG table key throws — proves per-table HKDF gates access", () => {
    const k = crypto.randomBytes(32);
    const ct = encryptForColumn(k, "events", "secret");
    expect(() => decryptFromColumn(k, "threads", ct)).toThrow();
  });

  it("encrypted-row uses usrcp-local crypto BY REFERENCE — copy-paste regression check", async () => {
    // If someone copies encrypt/decrypt into usrcp-stream instead of
    // importing them, the function-reference identity check in
    // crypto-reuse.test.ts breaks. This is a backstop assertion that
    // pins the same property without spinning up the full test.
    const row = await import("../db/encrypted-row.js");
    expect(row._crypto.encrypt).toBe(encryption.encrypt);
    expect(row._crypto.decrypt).toBe(encryption.decrypt);
  });
});
