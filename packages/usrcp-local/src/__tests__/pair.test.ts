import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setUserSlug,
  initializeMasterKey,
  deriveFromPairingCode,
  decrypt,
  encrypt,
  zeroBuffer,
  FIXED_PAIRING_SALT,
  getUserDir,
} from "../encryption.js";
import { initializeIdentity, getDecryptedPrivateKeyPem } from "../crypto.js";
import {
  pairInit,
  pairJoin,
  pairStatus,
  pairCancel,
  formatCode,
  InvalidPairingCode,
  WrongPassphrase,
  PairingExpired,
  PairingLocked,
} from "../pair.js";

const PASSPHRASE = "correct-horse-battery-staple";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function initDeviceA(): { userDir: string; publicKey: string; privateKey: string } {
  const masterKey = initializeMasterKey(PASSPHRASE);
  initializeIdentity(masterKey);
  const userDir = getUserDir();
  const publicKey = fs.readFileSync(path.join(userDir, "keys", "public.pem"), "utf-8");
  const privateKey = getDecryptedPrivateKeyPem(masterKey);
  zeroBuffer(masterKey);
  return { userDir, publicKey, privateKey };
}

// --- Stub fetch that maps to an in-memory pairing-bundles store. ---

interface StubServerState {
  bundles: Map<string, { encrypted_bundle: string; owner_public_key: string; expires_at: string; claim_attempts: number }>;
  collisionCount?: number; // force N upfront CODE_COLLISION responses on POST
  ownerForPost?: string;   // public key the server should record as owner
}

function stubFetch(state: StubServerState): typeof fetch {
  const impl = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? String(init.body) : "";

    if (method === "POST" && u.pathname === "/v1/pairing/init") {
      if ((state.collisionCount ?? 0) > 0) {
        state.collisionCount! -= 1;
        return new Response(
          JSON.stringify({ error: "CODE_COLLISION" }),
          { status: 409, headers: { "content-type": "application/json" } }
        );
      }
      const parsed = JSON.parse(body);
      const owner =
        state.ownerForPost ??
        decodeOwnerFromHeaders(init?.headers as Record<string, string>) ??
        "pub-unknown";
      state.bundles.set(parsed.code, {
        encrypted_bundle: parsed.encrypted_bundle,
        owner_public_key: owner,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        claim_attempts: 0,
      });
      return new Response(
        JSON.stringify({ ok: true, expires_at: state.bundles.get(parsed.code)!.expires_at }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (method === "GET" && u.pathname.startsWith("/v1/pairing/claim/")) {
      const code = u.pathname.split("/").pop()!;
      const row = state.bundles.get(code);
      if (!row) {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
      }
      row.claim_attempts += 1;
      if (row.claim_attempts > 5) {
        return new Response(JSON.stringify({ error: "TOO_MANY_ATTEMPTS" }), { status: 429 });
      }
      return new Response(
        JSON.stringify({
          encrypted_bundle: row.encrypted_bundle,
          owner_public_key: row.owner_public_key,
          expires_at: row.expires_at,
          attempts_remaining: 5 - row.claim_attempts,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (method === "GET" && u.pathname === "/v1/pairing/list") {
      const owner = decodeOwnerFromHeaders(init?.headers as Record<string, string>) ?? "";
      const out = Array.from(state.bundles.entries())
        .filter(([, row]) => row.owner_public_key === owner)
        .map(([code, row]) => ({
          code,
          expires_at: row.expires_at,
          claim_attempts: row.claim_attempts,
        }));
      return new Response(JSON.stringify({ bundles: out }), { status: 200 });
    }

    if (method === "DELETE" && u.pathname.startsWith("/v1/pairing/")) {
      const code = u.pathname.split("/").pop()!;
      const owner = decodeOwnerFromHeaders(init?.headers as Record<string, string>) ?? "";
      const row = state.bundles.get(code);
      if (!row || row.owner_public_key !== owner) {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
      }
      state.bundles.delete(code);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "NO_ROUTE", url, method }), { status: 404 });
  };
  return impl as unknown as typeof fetch;
}

function decodeOwnerFromHeaders(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  const b64 = headers["x-usrcp-publickey"] ?? headers["X-Usrcp-PublicKey"];
  if (!b64) return null;
  return Buffer.from(b64, "base64").toString("utf-8");
}

// --- Tests ---

describe("formatCode", () => {
  it("formats 8 digits as XXXX-XXXX", () => {
    expect(formatCode("12345678")).toBe("1234-5678");
    expect(formatCode("abc")).toBe("abc");
  });
});

describe("FIXED_PAIRING_SALT", () => {
  it("is 32 bytes (matches scrypt convention)", () => {
    expect(FIXED_PAIRING_SALT.length).toBe(32);
  });
});

describe("pairInit", () => {
  it("writes a bundle whose code decrypts to the four source artifacts", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const { code, expires_at } = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(/^[0-9]{8}$/.test(code)).toBe(true);
    expect(expires_at).not.toBe("");

    const row = state.bundles.get(code)!;
    const key = deriveFromPairingCode(code);
    const bundleJson = decrypt(row.encrypted_bundle, key);
    zeroBuffer(key);
    const bundle = JSON.parse(bundleJson);

    expect(bundle.schema_v).toBe(1);
    // salt + verify round-trip byte-for-byte against the original files.
    expect(Buffer.from(bundle.salt, "base64").toString("hex")).toBe(
      fs.readFileSync(path.join(userDir, "keys", "master.salt")).toString("hex")
    );
    expect(Buffer.from(bundle.verify, "base64").toString("hex")).toBe(
      fs.readFileSync(path.join(userDir, "keys", "master.verify")).toString("hex")
    );
    expect(bundle.identity.public_key).toBe(publicKey);
    expect(bundle.private_pem_enc.startsWith("enc:")).toBe(true);
    // The bundle contains the encrypted private key verbatim from disk.
    expect(bundle.private_pem_enc).toBe(
      fs.readFileSync(path.join(userDir, "keys", "private.pem"), "utf-8").trim()
    );
  });

  it("retries when the server returns CODE_COLLISION and eventually succeeds", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), collisionCount: 2, ownerForPost: publicKey };
    const r = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(r.code).toMatch(/^[0-9]{8}$/);
    expect(state.collisionCount).toBe(0);
  });
});

describe("pairJoin", () => {
  async function makeBundleOnServer(): Promise<{
    code: string;
    state: StubServerState;
    sourceUserDir: string;
    publicKey: string;
  }> {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const { code } = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    return { code, state, sourceUserDir: userDir, publicKey };
  }

  it("writes the six expected key files and validates the passphrase", async () => {
    const { code, state, sourceUserDir, publicKey } = await makeBundleOnServer();

    // Switch to a fresh HOME so the device-B writes go to an empty dir.
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");

    const result = await pairJoin(code, {
      userDir: path.join(process.env.HOME!, ".usrcp", "users", "default"),
      passphrase: PASSPHRASE,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(result.public_key).toBe(publicKey);

    const bKeysDir = path.join(process.env.HOME!, ".usrcp", "users", "default", "keys");
    for (const name of ["master.salt", "master.verify", "mode", "identity.json", "private.pem", "public.pem"]) {
      expect(fs.existsSync(path.join(bKeysDir, name))).toBe(true);
    }
    // identity.json byte equality with the source device.
    const aIdentity = JSON.parse(fs.readFileSync(path.join(sourceUserDir, "keys", "identity.json"), "utf-8"));
    const bIdentity = JSON.parse(fs.readFileSync(path.join(bKeysDir, "identity.json"), "utf-8"));
    expect(bIdentity).toEqual(aIdentity);

    // master.salt + master.verify equal.
    expect(fs.readFileSync(path.join(bKeysDir, "master.salt")).toString("hex"))
      .toBe(fs.readFileSync(path.join(sourceUserDir, "keys", "master.salt")).toString("hex"));
    expect(fs.readFileSync(path.join(bKeysDir, "master.verify")).toString("hex"))
      .toBe(fs.readFileSync(path.join(sourceUserDir, "keys", "master.verify")).toString("hex"));

    // mode is "passphrase".
    expect(fs.readFileSync(path.join(bKeysDir, "mode"), "utf-8")).toBe("passphrase");

    // initializeMasterKey + getDecryptedPrivateKeyPem succeed on device B.
    const masterKey = initializeMasterKey(PASSPHRASE);
    expect(getDecryptedPrivateKeyPem(masterKey).includes("BEGIN PRIVATE KEY")).toBe(true);
    zeroBuffer(masterKey);
  });

  it("rolls back all writes when the passphrase is wrong", async () => {
    const { code, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");

    await expect(
      pairJoin(code, {
        userDir: bUserDir,
        passphrase: "wrong-passphrase",
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(WrongPassphrase);

    // The whole keys/ should be empty (we removed every file we wrote).
    const remaining = fs.existsSync(bKeysDir)
      ? fs.readdirSync(bKeysDir)
      : [];
    expect(remaining).toEqual([]);
  });

  it("refuses to overwrite an existing identity.json unless force=true", async () => {
    const { code, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");
    fs.mkdirSync(bKeysDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bKeysDir, "identity.json"), '{"user_id":"u_existing","public_key":"","created_at":""}');

    await expect(
      pairJoin(code, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/already exists/);

    // The existing identity is untouched.
    const cur = JSON.parse(fs.readFileSync(path.join(bKeysDir, "identity.json"), "utf-8"));
    expect(cur.user_id).toBe("u_existing");
  });

  it("refuses to install a plaintext (non-`enc:`) bundle that bypasses scrypt", async () => {
    // A malicious server could serve a plaintext JSON bundle, which would
    // bypass the scrypt-derived pairing key because decrypt() returns
    // non-`enc:` input verbatim for legacy compatibility. pairJoin must
    // reject anything that isn't ciphertext.
    const { code, state } = await makeBundleOnServer();
    const row = state.bundles.get(code)!;
    row.encrypted_bundle = JSON.stringify({
      schema_v: 1,
      salt: Buffer.alloc(32).toString("base64"),
      verify: Buffer.alloc(32).toString("base64"),
      identity: { user_id: "u_attacker", public_key: "fake-pem", created_at: "" },
      private_pem_enc: "enc:0000000000000000000000",
    });
    expect(row.encrypted_bundle.startsWith("enc:")).toBe(false);
    expect(row.encrypted_bundle.length).toBeGreaterThan(16);

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    await expect(
      pairJoin(code, {
        userDir: path.join(process.env.HOME!, ".usrcp", "users", "default"),
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
  });

  it("preserves existing keys on rollback when force=true and the join fails", async () => {
    // Set up Alice's identity that we'll attempt to pair into Bob's slot.
    const { code, state } = await makeBundleOnServer();

    // Now set up Bob with a DIFFERENT identity already in keys/ - simulating
    // a stale install the user is intentionally overwriting via --force.
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const masterKeyB = initializeMasterKey("bob-original-passphrase");
    initializeIdentity(masterKeyB);
    const bUserDir = getUserDir();
    const bKeysDir = path.join(bUserDir, "keys");

    const snap = (name: string) =>
      fs.readFileSync(path.join(bKeysDir, name)).toString("hex");
    const before = {
      salt: snap("master.salt"),
      verify: snap("master.verify"),
      identity: snap("identity.json"),
      privatePem: snap("private.pem"),
      publicPem: snap("public.pem"),
      mode: fs.readFileSync(path.join(bKeysDir, "mode"), "utf-8"),
    };

    // Run with WRONG passphrase + force; pairJoin must roll back without
    // destroying Bob's pre-existing identity.
    await expect(
      pairJoin(code, {
        userDir: bUserDir,
        passphrase: "wrong-passphrase-on-purpose",
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
        force: true,
      })
    ).rejects.toBeInstanceOf(WrongPassphrase);

    expect(snap("master.salt")).toBe(before.salt);
    expect(snap("master.verify")).toBe(before.verify);
    expect(snap("identity.json")).toBe(before.identity);
    expect(snap("private.pem")).toBe(before.privatePem);
    expect(snap("public.pem")).toBe(before.publicPem);
    expect(fs.readFileSync(path.join(bKeysDir, "mode"), "utf-8")).toBe(before.mode);

    // Bob can still unlock with his original passphrase.
    const restored = initializeMasterKey("bob-original-passphrase");
    zeroBuffer(restored);
  });

  it("surfaces InvalidPairingCode when the bundle decryption fails", async () => {
    const { code, state } = await makeBundleOnServer();
    // Replace the bundle ciphertext with a ciphertext that decrypts under a
    // DIFFERENT code's key. That hits the bundle-decrypt failure branch.
    const wrongKey = deriveFromPairingCode("99999999");
    const tampered = encrypt('{"schema_v":1,"this":"is wrong"}', wrongKey);
    zeroBuffer(wrongKey);
    const row = state.bundles.get(code)!;
    row.encrypted_bundle = tampered;

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");

    await expect(
      pairJoin(code, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
  });

  it("rejects malformed codes before talking to the server", async () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const calls: string[] = [];
    const noisyFetch: typeof fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      pairJoin("12345", {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: noisyFetch,
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
    expect(calls.length).toBe(0);
  });

  it("maps 404 to PairingExpired and 429 to PairingLocked", async () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");

    const expiredFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 })) as unknown as typeof fetch;
    await expect(
      pairJoin("12345678", {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: expiredFetch,
      })
    ).rejects.toBeInstanceOf(PairingExpired);

    const lockedFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "TOO_MANY_ATTEMPTS" }), { status: 429 })) as unknown as typeof fetch;
    await expect(
      pairJoin("12345678", {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: lockedFetch,
      })
    ).rejects.toBeInstanceOf(PairingLocked);
  });
});

describe("pairStatus / pairCancel", () => {
  it("returns the owner's pending bundles and can cancel one", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const { code } = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });

    const list = await pairStatus({
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(list.length).toBe(1);
    expect(list[0].code).toBe(code);

    await pairCancel(code, {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(state.bundles.has(code)).toBe(false);

    // cancelling again throws PairingExpired.
    await expect(
      pairCancel(code, {
        publicKeyPem: publicKey,
        privateKeyPem: privateKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(PairingExpired);
  });
});
