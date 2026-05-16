import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  setUserSlug,
  initializeMasterKey,
  zeroBuffer,
  getUserDir,
  decrypt,
  deriveGlobalEncryptionKey,
} from "../encryption.js";
import { initializeIdentity, getDecryptedPrivateKeyPem } from "../crypto.js";
import { rotateIdentity } from "../rotate-identity.js";

const PASSPHRASE = "correct-horse-battery-staple-rotate";
const ROTATE_DOMAIN = "usrcp-rotate-v1";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-rotate-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function initDevice(passphrase = PASSPHRASE): {
  userDir: string;
  publicKey: string;
  masterKey: Buffer;
} {
  const masterKey = initializeMasterKey(passphrase);
  initializeIdentity(masterKey);
  const userDir = getUserDir();
  const publicKey = fs.readFileSync(path.join(userDir, "keys", "public.pem"), "utf-8");
  return { userDir, publicKey, masterKey };
}

interface StubServerState {
  rotated?: { old_public_key: string; new_public_key: string; rotation_attestation: string; postedBody: string };
  status: number;
  errorBody?: any;
}

function stubFetch(state: StubServerState): typeof fetch {
  const impl = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    if (u.pathname === "/v1/rotate-identity" && init?.method === "POST") {
      const body = init.body ? String(init.body) : "";
      const parsed = JSON.parse(body);
      const headers = init.headers as Record<string, string>;
      const oldPubB64 = headers["x-usrcp-publickey"];
      const oldPub = Buffer.from(oldPubB64, "base64").toString("utf-8");
      state.rotated = {
        old_public_key: oldPub,
        new_public_key: parsed.new_public_key,
        rotation_attestation: parsed.rotation_attestation,
        postedBody: body,
      };
      if (state.status === 200) {
        return new Response(
          JSON.stringify({
            ok: true,
            old_public_key: oldPub,
            new_public_key: parsed.new_public_key,
            revoked_at: new Date().toISOString(),
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify(state.errorBody ?? { error: "FAIL" }),
        { status: state.status, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "NO_ROUTE", url }), { status: 404 });
  };
  return impl as unknown as typeof fetch;
}

describe("rotateIdentity (happy path)", () => {
  it("POSTs an attestation by the OLD key over `usrcp-rotate-v1\\n<new_pub>` and writes the new keys", async () => {
    const { userDir, publicKey: oldPub, masterKey } = initDevice();
    const state: StubServerState = { status: 200 };
    const oldIdentityRaw = fs.readFileSync(path.join(userDir, "keys", "identity.json"), "utf-8");
    const oldIdentity = JSON.parse(oldIdentityRaw);

    const r = await rotateIdentity({
      userDir,
      masterKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(r.old_public_key).toBe(oldPub);
    expect(r.new_public_key).not.toBe(oldPub);
    expect(r.new_user_id).not.toBe(oldIdentity.user_id);
    expect(r.new_user_id.startsWith("u_")).toBe(true);

    // The new identity.json is on disk.
    const newIdentity = JSON.parse(fs.readFileSync(path.join(userDir, "keys", "identity.json"), "utf-8"));
    expect(newIdentity.public_key).toBe(r.new_public_key);
    expect(newIdentity.user_id).toBe(r.new_user_id);
    // created_at carries over from the original identity.
    expect(newIdentity.created_at).toBe(oldIdentity.created_at);

    // The on-disk public.pem matches.
    expect(fs.readFileSync(path.join(userDir, "keys", "public.pem"), "utf-8")).toBe(r.new_public_key);

    // private.pem is encrypted ciphertext. Decrypting with the SAME master key
    // yields a valid Ed25519 PEM that matches the new public key.
    const cipher = fs.readFileSync(path.join(userDir, "keys", "private.pem"), "utf-8").trim();
    expect(cipher.startsWith("enc:")).toBe(true);
    const globalKey = deriveGlobalEncryptionKey(masterKey);
    const decryptedPriv = decrypt(cipher, globalKey);
    zeroBuffer(globalKey);
    expect(decryptedPriv.includes("BEGIN PRIVATE KEY")).toBe(true);
    // crypto.createPublicKey from the decrypted private key produces a key
    // whose PEM equals r.new_public_key.
    const derivedPub = crypto.createPublicKey(decryptedPriv);
    const derivedPubPem = derivedPub.export({ type: "spki", format: "pem" });
    expect(derivedPubPem).toBe(r.new_public_key);

    // Server saw an attestation that verifies under the OLD key over the canonical bytes.
    const att = Buffer.from(state.rotated!.rotation_attestation, "base64url");
    const canon = Buffer.from(`${ROTATE_DOMAIN}\n${r.new_public_key}`, "utf8");
    const oldKey = crypto.createPublicKey(oldPub);
    expect(crypto.verify(null, canon, oldKey, att)).toBe(true);

    zeroBuffer(masterKey);
  });

  it("the new private.pem unlocks under the SAME passphrase via initializeMasterKey", async () => {
    const { userDir, masterKey } = initDevice();
    const state: StubServerState = { status: 200 };
    await rotateIdentity({
      userDir,
      masterKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    zeroBuffer(masterKey);

    // Simulate a fresh process: re-derive the master key from the existing
    // master.salt + master.verify on disk and confirm getDecryptedPrivateKeyPem
    // still works.
    const reMaster = initializeMasterKey(PASSPHRASE);
    const priv = getDecryptedPrivateKeyPem(reMaster);
    expect(priv.includes("BEGIN PRIVATE KEY")).toBe(true);
    zeroBuffer(reMaster);
  });
});

describe("rotateIdentity (failure paths)", () => {
  it("leaves the local keys/ untouched when the cloud rejects rotation", async () => {
    const { userDir, masterKey } = initDevice();
    const state: StubServerState = { status: 409, errorBody: { error: "NEW_KEY_IN_USE" } };
    const beforeIdentity = fs.readFileSync(path.join(userDir, "keys", "identity.json")).toString("hex");
    const beforePrivate = fs.readFileSync(path.join(userDir, "keys", "private.pem")).toString("hex");
    const beforePublic = fs.readFileSync(path.join(userDir, "keys", "public.pem")).toString("hex");

    await expect(
      rotateIdentity({
        userDir,
        masterKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/cloud rejected/i);

    expect(fs.readFileSync(path.join(userDir, "keys", "identity.json")).toString("hex")).toBe(beforeIdentity);
    expect(fs.readFileSync(path.join(userDir, "keys", "private.pem")).toString("hex")).toBe(beforePrivate);
    expect(fs.readFileSync(path.join(userDir, "keys", "public.pem")).toString("hex")).toBe(beforePublic);
    zeroBuffer(masterKey);
  });

  it("preserves K2 in a sidecar backup when the canonical local write fails after cloud accepts", async () => {
    const { userDir, masterKey } = initDevice();
    const state: StubServerState = { status: 200 };
    const privatePath = path.join(userDir, "keys", "private.pem");
    const publicPath = path.join(userDir, "keys", "public.pem");

    // Sabotage: replace public.pem with a symlink to a real file
    // (/etc/hosts is universally readable). The pre-flight existsSync
    // check resolves the symlink and passes, but safeWriteFile's lstat
    // check sees the symlink and refuses to overwrite it - so the
    // canonical local write fails after the cloud has already 200d
    // and after K2's encrypted private key is in the .bak file.
    fs.unlinkSync(publicPath);
    fs.symlinkSync("/etc/hosts", publicPath);

    const priorPrivateHex = fs.readFileSync(privatePath).toString("hex");

    await expect(
      rotateIdentity({
        userDir,
        masterKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/cloud accepted rotation but the local write failed/i);

    // The canonical private.pem was rewritten to K2 BEFORE the public.pem
    // step failed (writes run in order: private -> public -> identity).
    // So canonical now holds K2, NOT a rollback to K1.
    expect(fs.readFileSync(privatePath).toString("hex")).not.toBe(priorPrivateHex);

    // The sidecar backup file exists with K2's encrypted private key.
    const keysDir = path.join(userDir, "keys");
    const backups = fs.readdirSync(keysDir).filter((f) => f.startsWith("private.pem.rotated-") && f.endsWith(".bak"));
    expect(backups.length).toBe(1);
    // The backup is byte-equal to the canonical (both are K2's encrypted private key).
    expect(fs.readFileSync(path.join(keysDir, backups[0])).toString("hex"))
      .toBe(fs.readFileSync(privatePath).toString("hex"));

    // Cleanup symlink for afterEach rm.
    fs.unlinkSync(publicPath);
    zeroBuffer(masterKey);
  });

  it("does NOT leave a backup file behind on a clean rotation", async () => {
    const { userDir, masterKey } = initDevice();
    const state: StubServerState = { status: 200 };
    await rotateIdentity({
      userDir,
      masterKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    const keysDir = path.join(userDir, "keys");
    const backups = fs.readdirSync(keysDir).filter((f) => f.startsWith("private.pem.rotated-"));
    expect(backups).toEqual([]);
    zeroBuffer(masterKey);
  });

  it("does NOT leave a backup file behind when the cloud rejects", async () => {
    const { userDir, masterKey } = initDevice();
    const state: StubServerState = { status: 409, errorBody: { error: "NEW_KEY_IN_USE" } };
    await expect(
      rotateIdentity({
        userDir,
        masterKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow();
    const keysDir = path.join(userDir, "keys");
    const backups = fs.readdirSync(keysDir).filter((f) => f.startsWith("private.pem.rotated-"));
    expect(backups).toEqual([]);
    zeroBuffer(masterKey);
  });

  it("rejects when private.pem is missing on disk", async () => {
    const { userDir, masterKey } = initDevice();
    fs.unlinkSync(path.join(userDir, "keys", "private.pem"));
    const state: StubServerState = { status: 200 };
    await expect(
      rotateIdentity({
        userDir,
        masterKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/missing required key file/i);
    zeroBuffer(masterKey);
  });
});
