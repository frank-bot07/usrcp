import { describe, it, expect } from "vitest";
import * as encryption from "usrcp-core/encryption";
import { _crypto } from "../db/encrypted-row.js";

// This test catches the regression where someone copy-pastes the crypto
// helpers into usrcp-stream instead of importing them. Identity comparison
// (===) on the function reference is the strongest check available short
// of statically banning re-implementation in CI lint rules.

describe("crypto-reuse", () => {
  it("encryptForColumn uses usrcp-local.encrypt by reference", () => {
    expect(_crypto.encrypt).toBe(encryption.encrypt);
  });

  it("decryptFromColumn uses usrcp-local.decrypt by reference", () => {
    expect(_crypto.decrypt).toBe(encryption.decrypt);
  });

  it("uses usrcp-local.isEncrypted by reference", () => {
    expect(_crypto.isEncrypted).toBe(encryption.isEncrypted);
  });

  it("uses usrcp-local.deriveDomainEncryptionKey by reference", () => {
    expect(_crypto.deriveDomainEncryptionKey).toBe(
      encryption.deriveDomainEncryptionKey
    );
  });
});
