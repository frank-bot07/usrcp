import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setUserSlug,
  initializeMasterKey,
  deriveFromPairingSecret,
  decrypt,
  encrypt,
  zeroBuffer,
  getUserDir,
} from "usrcp-core/encryption";
import { initializeIdentity, getDecryptedPrivateKeyPem } from "usrcp-core/crypto";
import {
  pairInit,
  pairJoin,
  pairStatus,
  pairCancel,
  formatCode,
  formatPairingString,
  parsePairingString,
  InvalidPairingCode,
  WrongPassphrase,
  PairingExpired,
  PairingLocked,
} from "usrcp-core/pair";
import { renderPairingQr } from "../pair-qr.js";

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
  lastPostBody?: string;   // most recent POST /v1/pairing/init body (for assertions)
}

function stubFetch(state: StubServerState): typeof fetch {
  const impl = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? String(init.body) : "";

    if (method === "POST" && u.pathname === "/v1/pairing/init") {
      state.lastPostBody = body;
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

describe("renderPairingQr", () => {
  it("returns a non-empty QR rendering for a v2 pairing string", () => {
    const pairingString = formatPairingString("12345678", Buffer.alloc(16, 0xab));
    const qr = renderPairingQr(pairingString);
    expect(qr.length).toBeGreaterThan(0);
    // qrcode-terminal `small: true` mode renders QR cells via half-block
    // Unicode characters: U+2580 (UPPER HALF BLOCK), U+2584 (LOWER HALF
    // BLOCK), U+2588 (FULL BLOCK), plus spaces for white cells. At least
    // one of these must be present in a real QR rendering.
    expect(/[▀▄█]/.test(qr)).toBe(true);
    // Multi-line: a QR is at least ~10 lines for a 40-ish char payload
    // even at compact rendering.
    expect(qr.split("\n").length).toBeGreaterThan(5);
  });

  it("produces stable output for the same input", () => {
    const pairingString = "12345678-aabbccdd-eeff0011-22334455-66778899";
    expect(renderPairingQr(pairingString)).toBe(renderPairingQr(pairingString));
  });
});

describe("pairing-string format helpers", () => {
  it("formatPairingString produces a 40-char body split into six groups", () => {
    const code = "12345678";
    const secret = Buffer.from("0123456789abcdef" + "fedcba9876543210", "hex");
    expect(secret.length).toBe(16);
    const s = formatPairingString(code, secret);
    expect(s).toBe("1234-5678-01234567-89abcdef-fedcba98-76543210");
    expect(s.replace(/-/g, "").length).toBe(8 + 32);
  });

  it("parsePairingString round-trips with formatPairingString", () => {
    const code = "98765432";
    const secret = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const s = formatPairingString(code, secret);
    const parsed = parsePairingString(s);
    expect(parsed.code).toBe(code);
    expect(parsed.secret.equals(secret)).toBe(true);
  });

  it("parsePairingString accepts whitespace, mixed case, and missing hyphens", () => {
    const a = parsePairingString("1234-5678-AABBCCDD-EEFF0011-22334455-66778899");
    const b = parsePairingString("1234 5678 aabbccdd eeff0011 22334455 66778899");
    const c = parsePairingString("12345678aabbccddeeff001122334455 66778899");
    expect(a.code).toBe("12345678");
    expect(a.secret.toString("hex")).toBe("aabbccddeeff001122334455" + "66778899");
    expect(b.code).toBe(a.code); expect(b.secret.equals(a.secret)).toBe(true);
    expect(c.code).toBe(a.code); expect(c.secret.equals(a.secret)).toBe(true);
  });

  it("parsePairingString rejects too-short, too-long, and non-hex tails", () => {
    for (const bad of [
      "1234-5678",                                              // missing secret
      "1234-5678-aabbccdd",                                     // partial secret
      "1234-5678-aabbccdd-eeff0011-22334455-66778899-EXTRA",    // too long
      "abcd-5678-aabbccdd-eeff0011-22334455-66778899",          // non-digit prefix
      "1234-5678-zzzzzzzz-zzzzzzzz-zzzzzzzz-zzzzzzzz",          // non-hex secret
    ]) {
      expect(() => parsePairingString(bad)).toThrow(InvalidPairingCode);
    }
  });
});

describe("pairInit", () => {
  it("returns a pairing string whose secret decrypts the server-stored bundle", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const r = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(/^[0-9]{8}$/.test(r.code)).toBe(true);
    expect(r.expires_at).not.toBe("");
    const parsed = parsePairingString(r.pairingString);
    expect(parsed.code).toBe(r.code);
    expect(parsed.secret.length).toBe(16);

    // Derive the key client-side from the printed secret and confirm the
    // server-stored ciphertext decrypts to the source bundle.
    const row = state.bundles.get(r.code)!;
    const key = deriveFromPairingSecret(r.code, parsed.secret);
    const bundleJson = decrypt(row.encrypted_bundle, key);
    zeroBuffer(key);
    const bundle = JSON.parse(bundleJson);

    expect(bundle.schema_v).toBe(2);
    expect(Buffer.from(bundle.salt, "base64").toString("hex")).toBe(
      fs.readFileSync(path.join(userDir, "keys", "master.salt")).toString("hex")
    );
    expect(bundle.identity.public_key).toBe(publicKey);
    expect(bundle.private_pem_enc).toBe(
      fs.readFileSync(path.join(userDir, "keys", "private.pem"), "utf-8").trim()
    );
  });

  it("does NOT include the secret in the POST body sent to the server", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const r = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(state.lastPostBody).toBeDefined();
    const parsed = parsePairingString(r.pairingString);
    const secretHex = parsed.secret.toString("hex");
    // The hex secret must not appear anywhere in the POST body.
    expect(state.lastPostBody!.includes(secretHex)).toBe(false);
    // The pairing string as a whole must not appear either (different framing
    // but same hex content; defense in depth).
    expect(state.lastPostBody!.includes(r.pairingString)).toBe(false);
    // The 8-digit code IS sent (it's the lookup key).
    const sentBody = JSON.parse(state.lastPostBody!);
    expect(sentBody.code).toBe(r.code);
    expect(typeof sentBody.encrypted_bundle).toBe("string");
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
    pairingString: string;
    code: string;
    state: StubServerState;
    sourceUserDir: string;
    publicKey: string;
  }> {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const r = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    return { pairingString: r.pairingString, code: r.code, state, sourceUserDir: userDir, publicKey };
  }

  it("writes the six expected key files and validates the passphrase", async () => {
    const { pairingString, state, sourceUserDir, publicKey } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");

    const result = await pairJoin(pairingString, {
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
    const aIdentity = JSON.parse(fs.readFileSync(path.join(sourceUserDir, "keys", "identity.json"), "utf-8"));
    const bIdentity = JSON.parse(fs.readFileSync(path.join(bKeysDir, "identity.json"), "utf-8"));
    expect(bIdentity).toEqual(aIdentity);

    expect(fs.readFileSync(path.join(bKeysDir, "master.salt")).toString("hex"))
      .toBe(fs.readFileSync(path.join(sourceUserDir, "keys", "master.salt")).toString("hex"));
    expect(fs.readFileSync(path.join(bKeysDir, "master.verify")).toString("hex"))
      .toBe(fs.readFileSync(path.join(sourceUserDir, "keys", "master.verify")).toString("hex"));
    expect(fs.readFileSync(path.join(bKeysDir, "mode"), "utf-8")).toBe("passphrase");

    const masterKey = initializeMasterKey(PASSPHRASE);
    expect(getDecryptedPrivateKeyPem(masterKey).includes("BEGIN PRIVATE KEY")).toBe(true);
    zeroBuffer(masterKey);
  });

  it("rolls back all writes when the passphrase is wrong", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");

    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: "wrong-passphrase",
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(WrongPassphrase);

    const remaining = fs.existsSync(bKeysDir) ? fs.readdirSync(bKeysDir) : [];
    expect(remaining).toEqual([]);
  });

  it("refuses to overwrite an existing identity.json unless force=true", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");
    fs.mkdirSync(bKeysDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bKeysDir, "identity.json"), '{"user_id":"u_existing","public_key":"","created_at":""}');

    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/already exists/);

    const cur = JSON.parse(fs.readFileSync(path.join(bKeysDir, "identity.json"), "utf-8"));
    expect(cur.user_id).toBe("u_existing");
  });

  it("refuses to install a plaintext (non-`enc:`) bundle", async () => {
    const { pairingString, code, state } = await makeBundleOnServer();
    const row = state.bundles.get(code)!;
    row.encrypted_bundle = JSON.stringify({
      schema_v: 2,
      salt: Buffer.alloc(32).toString("base64"),
      verify: Buffer.alloc(32).toString("base64"),
      identity: { user_id: "u_attacker", public_key: "fake-pem", created_at: "" },
      private_pem_enc: "enc:0000000000000000000000",
    });
    expect(row.encrypted_bundle.startsWith("enc:")).toBe(false);

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    await expect(
      pairJoin(pairingString, {
        userDir: path.join(process.env.HOME!, ".usrcp", "users", "default"),
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
  });

  it("preserves existing keys on rollback when force=true and the join fails", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const masterKeyB = initializeMasterKey("bob-original-passphrase");
    initializeIdentity(masterKeyB);
    const bUserDir = getUserDir();
    const bKeysDir = path.join(bUserDir, "keys");

    const snap = (name: string) => fs.readFileSync(path.join(bKeysDir, name)).toString("hex");
    const before = {
      salt: snap("master.salt"),
      verify: snap("master.verify"),
      identity: snap("identity.json"),
      privatePem: snap("private.pem"),
      publicPem: snap("public.pem"),
      mode: fs.readFileSync(path.join(bKeysDir, "mode"), "utf-8"),
    };

    await expect(
      pairJoin(pairingString, {
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

    const restored = initializeMasterKey("bob-original-passphrase");
    zeroBuffer(restored);
  });

  it("surfaces InvalidPairingCode when the secret half does not decrypt", async () => {
    const { pairingString, code, state } = await makeBundleOnServer();
    // Replace the server-stored ciphertext with one encrypted under a
    // DIFFERENT random secret. The user-presented pairing string carries
    // the original secret, which won't decrypt the tampered ciphertext.
    const wrongSecret = Buffer.alloc(16, 7);
    const wrongKey = deriveFromPairingSecret(code, wrongSecret);
    const tampered = encrypt('{"schema_v":2,"this":"is wrong"}', wrongKey);
    zeroBuffer(wrongKey);
    state.bundles.get(code)!.encrypted_bundle = tampered;

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");

    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
  });

  it("rejects malformed pairing strings before talking to the server", async () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const calls: string[] = [];
    const noisyFetch: typeof fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      pairJoin("12345678", { // missing secret half
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: noisyFetch,
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
    expect(calls.length).toBe(0);
  });

  it("rejects a v1-style 8-digit code as a malformed pairing string", async () => {
    // v1 codes are an outright clean-break failure; a user paste of
    // "1234-5678" from an old binary must not be silently coerced.
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    await expect(
      pairJoin("1234-5678", {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);
  });

  it("maps 404 to PairingExpired and 429 to PairingLocked", async () => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const wellFormed = formatPairingString("12345678", Buffer.alloc(16, 1));

    const expiredFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 })) as unknown as typeof fetch;
    await expect(
      pairJoin(wellFormed, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: expiredFetch,
      })
    ).rejects.toBeInstanceOf(PairingExpired);

    const lockedFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: "TOO_MANY_ATTEMPTS" }), { status: 429 })) as unknown as typeof fetch;
    await expect(
      pairJoin(wellFormed, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: lockedFetch,
      })
    ).rejects.toBeInstanceOf(PairingLocked);
  });
});

describe("pairJoin atomic-write safety (PR #66)", () => {
  async function makeBundleOnServer(): Promise<{
    pairingString: string;
    code: string;
    state: StubServerState;
  }> {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const r = await pairInit({
      userDir,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    return { pairingString: r.pairingString, code: r.code, state };
  }

  it("never creates the canonical keys/ dir when the passphrase is wrong", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");

    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: "wrong-on-purpose",
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(WrongPassphrase);

    // The new flow validates the passphrase in memory and bails before
    // creating keys/. The pre-PR-#66 flow would have created keys/ and
    // populated it with all six files, then rolled them back via the
    // snapshot-restore path, leaving keys/ as an empty dir.
    expect(fs.existsSync(bKeysDir)).toBe(false);
  });

  it("rejects a bundle whose private_pem_enc was sealed under a different master key without writing keys/", async () => {
    const { pairingString, code, state } = await makeBundleOnServer();

    // Replace private_pem_enc with ciphertext encrypted under a
    // completely different master key. The bundle's salt+verify still
    // validate under PASSPHRASE, but the new in-memory sanity check
    // decrypts private_pem_enc with the derived global key and rejects.
    const sourceCipher = state.bundles.get(code)!.encrypted_bundle;
    expect(sourceCipher.startsWith("enc:")).toBe(true);

    // Decrypt the source bundle so we can re-emit a tampered version.
    const { secret } = parsePairingString(pairingString);
    const pairKey = deriveFromPairingSecret(code, secret);
    const sourceJson = decrypt(sourceCipher, pairKey);
    const parsed = JSON.parse(sourceJson) as {
      schema_v: number;
      salt: string;
      verify: string;
      identity: { user_id: string; public_key: string; created_at: string };
      private_pem_enc: string;
    };
    // Replace private_pem_enc with ciphertext encrypted under the
    // pairing key itself (which is NOT what the master key should be).
    parsed.private_pem_enc = encrypt("BEGIN FAKE PRIVATE KEY PEM", pairKey);
    zeroBuffer(pairKey);
    const tampered = encrypt(JSON.stringify(parsed), deriveFromPairingSecret(code, secret));
    state.bundles.get(code)!.encrypted_bundle = tampered;

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");

    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(InvalidPairingCode);

    expect(fs.existsSync(bKeysDir)).toBe(false);
  });

  it("leaves no keys-pair-staging.* sibling after a successful pairJoin", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");

    await pairJoin(pairingString, {
      userDir: bUserDir,
      passphrase: PASSPHRASE,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });

    const siblings = fs.readdirSync(bUserDir);
    expect(siblings.some((n) => n.startsWith("keys-pair-staging."))).toBe(false);
    expect(siblings.some((n) => n.startsWith("keys-replaced-by-pair."))).toBe(false);
    expect(siblings).toContain("keys");
  });

  it("sweeps stale keys-pair-staging.* dirs from a prior crashed pairJoin", async () => {
    const { pairingString, state } = await makeBundleOnServer();

    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    setUserSlug("default");
    const bUserDir = path.join(process.env.HOME!, ".usrcp", "users", "default");
    fs.mkdirSync(bUserDir, { recursive: true, mode: 0o700 });
    // Simulate a SIGKILLed prior pairJoin: a staging dir with a partial
    // set of files survives in the userDir.
    const orphan = path.join(bUserDir, "keys-pair-staging.deadbeef");
    fs.mkdirSync(orphan, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(orphan, "master.salt"), "garbage");

    await pairJoin(pairingString, {
      userDir: bUserDir,
      passphrase: PASSPHRASE,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });

    expect(fs.existsSync(orphan)).toBe(false);
    // The successful pairJoin still committed a valid keys/ dir.
    expect(fs.existsSync(path.join(bUserDir, "keys", "identity.json"))).toBe(true);
  });

  it("restores keys/ from a keys-replaced-by-pair.* orphan when the prior pairJoin died between renames", async () => {
    // Set up a fresh deviceA pairing to give pairJoin something to claim.
    const { pairingString, state } = await makeBundleOnServer();

    // Build deviceB userDir in an isolated tmp tree. Simulate the
    // SIGKILL-between-renames state: keys/ is absent and a
    // keys-replaced-by-pair.* sibling holds the prior identity.
    const bTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-pair-test-deviceB-"));
    const bUserDir = path.join(bTmpHome, ".usrcp", "users", "default");
    const bKeysDir = path.join(bUserDir, "keys");
    const asidePath = path.join(bUserDir, "keys-replaced-by-pair.deadbeef");
    fs.mkdirSync(asidePath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(asidePath, "identity.json"),
      '{"user_id":"u_priorB","public_key":"prior","created_at":""}'
    );
    fs.writeFileSync(path.join(asidePath, "master.salt"), "prior-salt");

    // Run pairJoin without force - the recovery sweep restores keys/
    // from the aside BEFORE the pre-flight identity.json check runs,
    // so the pre-flight then refuses without force.
    await expect(
      pairJoin(pairingString, {
        userDir: bUserDir,
        passphrase: PASSPHRASE,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toThrow(/already exists/);

    expect(fs.existsSync(bKeysDir)).toBe(true);
    expect(fs.readFileSync(path.join(bKeysDir, "identity.json"), "utf-8")).toContain("u_priorB");
    expect(fs.existsSync(asidePath)).toBe(false);

    fs.rmSync(bTmpHome, { recursive: true, force: true });
  });
});

describe("pairStatus / pairCancel", () => {
  it("uses just the 8-digit code (the secret is not needed for management)", async () => {
    const { userDir, publicKey, privateKey } = initDeviceA();
    const state: StubServerState = { bundles: new Map(), ownerForPost: publicKey };
    const r = await pairInit({
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
    expect(list[0].code).toBe(r.code);

    await pairCancel(r.code, {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      endpoint: "http://stub",
      fetchImpl: stubFetch(state),
    });
    expect(state.bundles.has(r.code)).toBe(false);

    await expect(
      pairCancel(r.code, {
        publicKeyPem: publicKey,
        privateKeyPem: privateKey,
        endpoint: "http://stub",
        fetchImpl: stubFetch(state),
      })
    ).rejects.toBeInstanceOf(PairingExpired);
  });
});
