/**
 * Multi-device pairing (v2 = code + out-of-band secret).
 *
 * Device A: `pairInit` generates two values - an 8-digit `code` and a
 * 16-byte random `secret`. It bundles the local identity (master.salt,
 * master.verify, identity.json, encrypted private.pem), encrypts the
 * bundle under HKDF(IKM=secret, salt=code, info="usrcp-pairing-v2"),
 * and POSTs the ciphertext to /v1/pairing/init with ONLY the code as
 * the lookup key. The secret never leaves the device through the cloud
 * path - it travels device-to-device via the printed pairing string,
 * a QR code, or any other out-of-band channel.
 *
 * Device B: `pairJoin` takes the full pairing string (code + secret),
 * GETs the ciphertext by code, derives the same key from secret+code,
 * decrypts, writes the key files atomically into userDir/keys/, and
 * validates the passphrase end-to-end. On any failure the partial
 * writes are rolled back to the pre-existing content (or unlinked when
 * no prior file existed).
 *
 * This supersedes the v1 design (8-digit code = scrypt input) where
 * the cloud held the decryption material during the TTL. In v2 the
 * cloud sees `(code, ciphertext)` only; the key requires the secret
 * which the cloud never sees. tasks/12-pair-tier-2.md has the design
 * write-up; the v1 model is retained as historical context in
 * tasks/11-multi-device-pairing.md.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import qrcode from "qrcode-terminal";
import {
  encrypt,
  decrypt,
  deriveFromPairingSecret,
  safeWriteFile,
  fsyncFile,
  fsyncDir,
  mkdirpDurable,
  deriveAndVerifyMasterKey,
  deriveGlobalEncryptionKey,
  setUserSlug,
  getUserSlug,
  zeroBuffer,
} from "./encryption.js";
import { type LedgerIdentity } from "./crypto.js";

const PAIRING_BUNDLE_SCHEMA_V = 2;
const MIN_BUNDLE_LEN = 16;
const PAIRING_SECRET_BYTES = 16;

export class InvalidPairingCode extends Error {
  constructor(message = "Invalid pairing code or bundle decryption failed.") {
    super(message);
    this.name = "InvalidPairingCode";
  }
}

export class WrongPassphrase extends Error {
  constructor(message = "Wrong passphrase for the pairing bundle.") {
    super(message);
    this.name = "WrongPassphrase";
  }
}

export class PairingExpired extends Error {
  constructor(message = "Pairing code expired or never existed.") {
    super(message);
    this.name = "PairingExpired";
  }
}

export class PairingLocked extends Error {
  constructor(message = "Pairing code locked after too many attempts. Re-init on device A.") {
    super(message);
    this.name = "PairingLocked";
  }
}

interface PairingBundle {
  schema_v: number;
  salt: string;             // base64(master.salt)
  verify: string;           // base64(master.verify)
  identity: LedgerIdentity;
  private_pem_enc: string;  // contents of private.pem (already enc:... ciphertext)
}

// --- Signing (kept in sync with packages/usrcp-cloud/src/auth.ts) ---

function canonicalRequest(
  method: string,
  pathWithQuery: string,
  timestampMs: number,
  nonce: string,
  body: string
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return Buffer.from(
    [method.toUpperCase(), pathWithQuery, String(timestampMs), nonce, bodyHash].join("\n"),
    "utf8"
  );
}

function signRequest(
  privateKeyPem: string,
  method: string,
  pathWithQuery: string,
  body: string
): { timestampMs: number; nonce: string; signature: string } {
  const timestampMs = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const canon = canonicalRequest(method, pathWithQuery, timestampMs, nonce, body);
  const sig = crypto.sign(null, canon, crypto.createPrivateKey(privateKeyPem));
  return { timestampMs, nonce, signature: sig.toString("base64url") };
}

async function signedFetch(
  endpoint: string,
  pathWithQuery: string,
  method: "GET" | "POST" | "DELETE",
  body: unknown | undefined,
  publicKeyPem: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; json: any }> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const signed = signRequest(privateKeyPem, method, pathWithQuery, bodyStr);
  const url = endpoint.replace(/\/$/, "") + pathWithQuery;
  const res = await fetchImpl(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-usrcp-publickey": Buffer.from(publicKeyPem).toString("base64"),
      "x-usrcp-timestamp": String(signed.timestampMs),
      "x-usrcp-nonce": signed.nonce,
      "x-usrcp-signature": signed.signature,
    },
    body: method === "POST" ? bodyStr : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// --- Helpers shared by pairInit / pairJoin ---

function keysDirOf(userDir: string): string {
  return path.join(userDir, "keys");
}

const PAIR_STAGING_PREFIX = "keys-pair-staging.";
const PAIR_REPLACED_PREFIX = "keys-replaced-by-pair.";

/**
 * Sweep orphan pair-join staging directories from prior crashed runs.
 * Called at the start of every pairJoin so a SIGKILL during the
 * write-to-staging phase does not leave the userDir littered.
 *
 * Also detects the (rare) replaced-by-pair-aside orphan that signals
 * a SIGKILL between the "rename existing keys/ aside" and "rename
 * staging into keys/" steps of a force-overwrite. In that case the
 * staging dir is incomplete (we crashed before its rename), so we
 * restore the original keys/ from the renamed-aside copy.
 */
function sweepStaleStagingDirs(userDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(userDir);
  } catch {
    return;
  }
  const keysDir = keysDirOf(userDir);
  for (const name of entries) {
    if (name.startsWith(PAIR_STAGING_PREFIX)) {
      try {
        fs.rmSync(path.join(userDir, name), { recursive: true, force: true });
      } catch {
        // Best-effort sweep; a leftover staging dir is harmless beyond disk use.
      }
    } else if (name.startsWith(PAIR_REPLACED_PREFIX)) {
      // Aside copy exists. If keys/ also exists, the prior pairJoin finished
      // the staging-to-keys rename but died before unlinking the aside; just
      // delete the aside. If keys/ is missing, restore from the aside (we
      // died between the two renames). fsync the parent dir after each
      // mutation so the recovery itself is power-loss-durable on this
      // boot (Codex round-2 P2 on PR #71).
      const asidePath = path.join(userDir, name);
      try {
        if (fs.existsSync(keysDir)) {
          fs.rmSync(asidePath, { recursive: true, force: true });
          fsyncDir(userDir);
        } else {
          fs.renameSync(asidePath, keysDir);
          fsyncDir(userDir);
        }
      } catch {
        // If recovery fails, leave the aside in place for manual inspection.
      }
    }
  }
}

/**
 * Atomically replace keysDir with stagingDir.
 *
 * Fresh-pair case (keysDir does not exist): single fs.renameSync,
 * atomic on POSIX.
 *
 * Force-overwrite case (keysDir exists): rename existing keysDir aside
 * to keys-replaced-by-pair.<rand>/, rename stagingDir into keysDir,
 * then rm the aside. A SIGKILL in this window is recovered by
 * sweepStaleStagingDirs on the next pairJoin.
 *
 * Power-loss durability: each rename is followed by an fsync of the
 * parent directory so the rename is on disk before the syscall
 * caller sees success. Without this, a power loss between the
 * rename returning and the kernel flushing the parent inode could
 * leave the directory listing reverting to the pre-rename state.
 * The fsync of the staging dir's contents happens at the caller
 * (right after the six safeWriteFile calls, before this function
 * runs).
 */
function commitStagingDir(stagingDir: string, keysDir: string): void {
  const userDir = path.dirname(keysDir);
  if (!fs.existsSync(keysDir)) {
    fs.renameSync(stagingDir, keysDir);
    fsyncDir(userDir);
    return;
  }
  const asideName = PAIR_REPLACED_PREFIX + crypto.randomBytes(8).toString("hex");
  const asidePath = path.join(userDir, asideName);
  fs.renameSync(keysDir, asidePath);
  fsyncDir(userDir);
  try {
    fs.renameSync(stagingDir, keysDir);
    fsyncDir(userDir);
  } catch (err) {
    // Restore original keysDir before propagating.
    try { fs.renameSync(asidePath, keysDir); fsyncDir(userDir); } catch {}
    throw err;
  }
  try {
    fs.rmSync(asidePath, { recursive: true, force: true });
    fsyncDir(userDir);
  } catch {
    // The new keys/ is already committed; an orphan aside is harmless
    // and will be cleaned by the next pairJoin's sweep.
  }
}

function readBundleSources(userDir: string): PairingBundle {
  const keysDir = keysDirOf(userDir);
  const saltPath = path.join(keysDir, "master.salt");
  const verifyPath = path.join(keysDir, "master.verify");
  const identityPath = path.join(keysDir, "identity.json");
  const privatePath = path.join(keysDir, "private.pem");

  for (const p of [saltPath, verifyPath, identityPath, privatePath]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `pairInit: missing required key file ${p}. The local ledger must be ` +
        `initialized in passphrase mode before pairing.`
      );
    }
  }

  const salt = fs.readFileSync(saltPath);
  const verify = fs.readFileSync(verifyPath);
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf-8")) as LedgerIdentity;
  const privatePemEnc = fs.readFileSync(privatePath, "utf-8").trim();

  if (!privatePemEnc.startsWith("enc:")) {
    throw new Error(
      "pairInit: private.pem is plaintext (legacy v0.1.x). Run a master-key " +
      "rotation first so it is encrypted before being included in a pairing bundle."
    );
  }

  return {
    schema_v: PAIRING_BUNDLE_SCHEMA_V,
    salt: salt.toString("base64"),
    verify: verify.toString("base64"),
    identity,
    private_pem_enc: privatePemEnc,
  };
}

function randomEightDigit(): string {
  // crypto.randomInt(min, max) - max is exclusive. We need 10_000_000-99_999_999.
  const n = crypto.randomInt(10_000_000, 100_000_000);
  return String(n);
}

// Pairing-string format:
//   <8 digit code>-<32 hex chars of the 16-byte secret>
// Displayed to the user as five 8-char groups separated by hyphens:
//   1234-5678-aabbccdd-eeff0011-22334455-66778899
// Lowercase hex (Buffer.toString("hex") default). The parser is
// permissive about whitespace, hyphens, and case.
const PAIRING_STRING_RE = /^[0-9]{8}[0-9a-f]{32}$/;
const PAIRING_STRING_SEPS = /[\s-]/g;

export function formatPairingString(code: string, secret: Buffer): string {
  if (!/^[0-9]{8}$/.test(code)) {
    throw new Error("formatPairingString: code must be exactly 8 digits.");
  }
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new Error(
      `formatPairingString: secret must be ${PAIRING_SECRET_BYTES} bytes.`
    );
  }
  const hex = secret.toString("hex");
  // 1234-5678 then 4 groups of 8 hex chars
  return [
    code.slice(0, 4),
    code.slice(4),
    hex.slice(0, 8),
    hex.slice(8, 16),
    hex.slice(16, 24),
    hex.slice(24, 32),
  ].join("-");
}

export interface ParsedPairingString {
  code: string;
  secret: Buffer;
}

export function parsePairingString(input: string): ParsedPairingString {
  const normalized = input.replace(PAIRING_STRING_SEPS, "").toLowerCase();
  if (!PAIRING_STRING_RE.test(normalized)) {
    throw new InvalidPairingCode(
      "Pairing string must be 8 digits followed by 32 hex characters (40 chars total, ignoring spaces and hyphens)."
    );
  }
  const code = normalized.slice(0, 8);
  const secret = Buffer.from(normalized.slice(8), "hex");
  return { code, secret };
}

// --- pairInit ---

export interface PairInitOpts {
  userDir: string;
  publicKeyPem: string;
  privateKeyPem: string;
  endpoint: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface PairInitResult {
  /** 8-digit lookup code that was sent to the server (no secret). */
  code: string;
  /** Full pairing string (code + secret) to share with device B. */
  pairingString: string;
  expires_at: string;
}

export async function pairInit(opts: PairInitOpts): Promise<PairInitResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const bundle = readBundleSources(opts.userDir);
  const bundleJson = JSON.stringify(bundle);

  // 3 attempts gives effectively-zero chance of repeated cross-user collisions.
  // The server's 409 CODE_COLLISION is the only retryable error here.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomEightDigit();
    // The secret stays with the printed pairing string; the cloud only
    // ever sees `code` and `encrypted_bundle`. Brand-new randomness per
    // attempt so a 409 retry doesn't reuse a leaked secret.
    const secret = crypto.randomBytes(PAIRING_SECRET_BYTES);
    let result: PairInitResult | undefined;
    try {
      const key = deriveFromPairingSecret(code, secret);
      let encryptedBundle: string;
      try {
        encryptedBundle = encrypt(bundleJson, key);
      } finally {
        zeroBuffer(key);
      }

      const body: Record<string, unknown> = { code, encrypted_bundle: encryptedBundle };
      if (opts.ttlSeconds !== undefined) body.ttl_seconds = opts.ttlSeconds;

      const { status, json } = await signedFetch(
        opts.endpoint,
        "/v1/pairing/init",
        "POST",
        body,
        opts.publicKeyPem,
        opts.privateKeyPem,
        fetchImpl
      );

      if (status === 200) {
        // Format BEFORE the outer finally zeroes the secret.
        result = {
          code,
          pairingString: formatPairingString(code, secret),
          expires_at: String(json?.expires_at ?? ""),
        };
      } else if (status === 409 && json?.error === "CODE_COLLISION") {
        // fall through to retry; outer finally still zeroes the secret
      } else {
        throw new Error(
          `pairInit failed: HTTP ${status} ${JSON.stringify(json ?? null)}`
        );
      }
    } finally {
      // Always zero the secret, including on a thrown fetch / network error.
      // The pairing string returned to the caller is the only copy that
      // survives this call.
      zeroBuffer(secret);
    }
    if (result) return result;
    // CODE_COLLISION: try again with fresh code + fresh secret.
  }
  throw new Error("pairInit failed: three CODE_COLLISION attempts in a row.");
}

// --- pairJoin ---

export interface PairJoinOpts {
  userDir: string;
  passphrase: string;
  endpoint: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
}

export async function pairJoin(
  pairingString: string,
  opts: PairJoinOpts
): Promise<{ user_id: string; public_key: string }> {
  // Parse early so a malformed input doesn't even hit the network.
  const { code, secret } = parsePairingString(pairingString);
  // Single try/finally guarantees the 16-byte secret Buffer is zeroed on
  // every exit path - including thrown fetches, JSON parse errors, and
  // unexpected exceptions - rather than leaving it live until GC.
  let key: Buffer | null = null;
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const keysDir = keysDirOf(opts.userDir);

    // Recovery sweep BEFORE the pre-flight check. If a prior pairJoin
    // crashed after renaming the old keys/ aside but before committing
    // the new staging dir, sweepStaleStagingDirs restores keys/ from
    // the aside. The pre-flight check below then correctly refuses
    // without --force, instead of letting the user silently overwrite a
    // recoverable identity.
    if (fs.existsSync(opts.userDir)) {
      sweepStaleStagingDirs(opts.userDir);
    }

    const identityPath = path.join(keysDir, "identity.json");
    if (fs.existsSync(identityPath) && !opts.force) {
      throw new Error(
        `pairJoin: ${identityPath} already exists. Pass force: true to overwrite.`
      );
    }

    // Unauthenticated GET - device B has no identity yet.
    const url = opts.endpoint.replace(/\/$/, "") + `/v1/pairing/claim/${code}`;
    const res = await fetchImpl(url, { method: "GET" });
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    if (res.status === 404) throw new PairingExpired();
    if (res.status === 429) throw new PairingLocked();
    if (res.status !== 200) {
      throw new Error(`pairJoin: claim failed: HTTP ${res.status} ${JSON.stringify(json ?? null)}`);
    }
    const ciphertext = String(json?.encrypted_bundle ?? "");
    if (ciphertext.length < MIN_BUNDLE_LEN) {
      throw new Error("pairJoin: server returned a too-short bundle.");
    }
    // Defense in depth: `decrypt()` returns non-`enc:` input verbatim for
    // pre-v0.1.3 plaintext compatibility. A malicious server could exploit
    // that to serve a plaintext JSON bundle that bypasses the
    // HKDF-derived pairing key entirely. Refuse anything that isn't
    // authenticated ciphertext before handing it to decrypt().
    if (!ciphertext.startsWith("enc:")) {
      throw new InvalidPairingCode("Pairing bundle is not ciphertext; refusing.");
    }

    key = deriveFromPairingSecret(code, secret);
    return await pairJoinAfterDecrypt(ciphertext, key, opts, keysDir);
  } finally {
    zeroBuffer(secret);
    if (key) zeroBuffer(key);
  }
}

async function pairJoinAfterDecrypt(
  ciphertext: string,
  key: Buffer,
  opts: PairJoinOpts,
  keysDir: string
): Promise<{ user_id: string; public_key: string }> {
  // Key is zeroed by the caller's outer try/finally, which also handles
  // the secret. We just use it here and never let it out of scope.
  let bundle: PairingBundle;
  let bundleJson: string;
  try {
    bundleJson = decrypt(ciphertext, key);
  } catch {
    throw new InvalidPairingCode();
  }
  try {
    bundle = JSON.parse(bundleJson);
  } catch {
    throw new InvalidPairingCode("Pairing bundle was not valid JSON after decryption.");
  }

  if (bundle.schema_v !== PAIRING_BUNDLE_SCHEMA_V) {
    throw new Error(
      `pairJoin: unsupported bundle schema_v=${bundle.schema_v} (expected ${PAIRING_BUNDLE_SCHEMA_V}; v1 codes are incompatible).`
    );
  }
  if (!bundle.identity?.public_key || !bundle.identity?.user_id) {
    throw new Error("pairJoin: bundle is missing required identity fields.");
  }
  if (!bundle.private_pem_enc?.startsWith("enc:")) {
    throw new Error("pairJoin: bundle private_pem_enc is not ciphertext.");
  }

  const saltBytes = Buffer.from(bundle.salt, "base64");
  const verifyBytes = Buffer.from(bundle.verify, "base64");

  // === Phase 1: in-memory validation (no disk writes) ===========
  //
  // The pre-PR-#66 implementation wrote all six key files to their final
  // canonical paths first and only then ran initializeMasterKey() to
  // validate the passphrase. The snapshot/restore rollback caught the
  // common case (wrong passphrase throws WrongPassphrase, files are
  // restored), but a SIGKILL anywhere between the first write and the
  // rollback could leave a partial identity on disk - bad enough to
  // confuse `initializeMasterKey()` on the next start. Validating
  // entirely in memory before touching disk closes that window.
  let masterKey: Buffer;
  try {
    masterKey = deriveAndVerifyMasterKey(opts.passphrase, saltBytes, verifyBytes);
  } catch (err) {
    if (err instanceof Error && /Invalid passphrase/i.test(err.message)) {
      throw new WrongPassphrase();
    }
    throw err;
  }
  try {
    // Sanity-check that private_pem_enc actually decrypts under the
    // master key derived from (passphrase, salt, verify). A bundle whose
    // verify hash matches but whose private_pem_enc was sealed under a
    // different master key would otherwise commit unreadable keys to
    // disk; here we catch it without writing anything.
    const globalKey = deriveGlobalEncryptionKey(masterKey);
    try {
      decrypt(bundle.private_pem_enc, globalKey);
    } catch {
      throw new InvalidPairingCode(
        "Bundle private_pem_enc does not decrypt under the bundle's verify-hash master key."
      );
    } finally {
      zeroBuffer(globalKey);
    }
  } finally {
    zeroBuffer(masterKey);
  }

  // === Phase 2: stage all key files in a sibling directory ======
  //
  // Writing into a temp sibling and then atomically renaming gives us
  // SIGKILL safety: at every moment the canonical keysDir either has
  // the prior (untouched) contents or the new fully-written contents.
  // The intermediate "partial set of files" state never reaches the
  // canonical path. Sweep any stale staging dirs from prior crashed
  // runs first so they don't accumulate.
  const userDir = path.dirname(keysDir);
  // mkdirpDurable rather than plain mkdirSync: on a brand-new
  // install, the entire ~/.usrcp/users/<slug>/ chain may be created
  // here. Without fsyncing each parent in the new chain, a power
  // loss after pair-join returns could lose one or more chain
  // links and leave the freshly committed keys/ unreachable.
  // (Codex round-2 P2 on PR #71.)
  mkdirpDurable(userDir, 0o700);
  sweepStaleStagingDirs(userDir);

  const stagingDir = fs.mkdtempSync(path.join(userDir, PAIR_STAGING_PREFIX));
  try {
    fs.chmodSync(stagingDir, 0o700);
    // Write + fsync each file: safeWriteFile is atomic against
    // SIGKILL but a power loss between the write returning and the
    // kernel flushing buffer cache could leave the file empty or
    // partial on next boot. fsyncFile forces the file's data + inode
    // to disk before we move on.
    const stagedFiles: Array<[string, Buffer, number]> = [
      [path.join(stagingDir, "master.salt"), saltBytes, 0o600],
      [path.join(stagingDir, "master.verify"), verifyBytes, 0o600],
      [path.join(stagingDir, "mode"), Buffer.from("passphrase"), 0o600],
      [
        path.join(stagingDir, "private.pem"),
        Buffer.from(bundle.private_pem_enc, "utf8"),
        0o600,
      ],
      [
        path.join(stagingDir, "public.pem"),
        Buffer.from(bundle.identity.public_key, "utf8"),
        0o644,
      ],
      [
        path.join(stagingDir, "identity.json"),
        Buffer.from(JSON.stringify(bundle.identity, null, 2), "utf8"),
        0o600,
      ],
    ];
    for (const [p, content, mode] of stagedFiles) {
      safeWriteFile(p, content, mode);
      fsyncFile(p);
    }
    // fsync the staging dir so its directory entries (the six files
    // we just wrote) are durably on disk BEFORE the rename in
    // commitStagingDir. Without this, a power loss after the rename
    // returns could leave the directory pointing at incomplete /
    // non-existent inodes when the parent's view is flushed.
    fsyncDir(stagingDir);

    commitStagingDir(stagingDir, keysDir);
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw err;
  }

  return {
    user_id: bundle.identity.user_id,
    public_key: bundle.identity.public_key,
  };
}

// --- pairStatus / pairCancel ---

export interface PairAuthOpts {
  publicKeyPem: string;
  privateKeyPem: string;
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export interface PairStatusEntry {
  code: string;
  expires_at: string;
  claim_attempts: number;
}

export async function pairStatus(opts: PairAuthOpts): Promise<PairStatusEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await signedFetch(
    opts.endpoint,
    "/v1/pairing/list",
    "GET",
    undefined,
    opts.publicKeyPem,
    opts.privateKeyPem,
    fetchImpl
  );
  if (status !== 200) {
    throw new Error(`pairStatus: HTTP ${status} ${JSON.stringify(json ?? null)}`);
  }
  return (json?.bundles ?? []) as PairStatusEntry[];
}

export async function pairCancel(code: string, opts: PairAuthOpts): Promise<void> {
  if (!/^[0-9]{8}$/.test(code)) {
    throw new Error("pairCancel: code must be exactly 8 digits.");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { status, json } = await signedFetch(
    opts.endpoint,
    `/v1/pairing/${code}`,
    "DELETE",
    undefined,
    opts.publicKeyPem,
    opts.privateKeyPem,
    fetchImpl
  );
  if (status === 200) return;
  if (status === 404) throw new PairingExpired();
  throw new Error(`pairCancel: HTTP ${status} ${JSON.stringify(json ?? null)}`);
}

// Re-exported for tests that need to inspect/format the code.
export function formatCode(code: string): string {
  return /^[0-9]{8}$/.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Render the pairing string as an ASCII QR code suitable for a
 * terminal. Returns the rendered string rather than printing so the
 * caller controls where it goes (stderr in the CLI, captured stdout
 * in tests, etc).
 *
 * `small: true` uses half-block Unicode characters so the QR fits in
 * roughly half the cells of the default rendering - the v2 pairing
 * string is short enough (~45 chars including hyphens) that even at
 * QR error-correction level L the result is a manageable ~25x25
 * module grid.
 */
export function renderPairingQr(pairingString: string): string {
  let captured = "";
  qrcode.generate(pairingString, { small: true }, (qr: string) => {
    captured = qr;
  });
  return captured;
}

// Re-exported so the CLI can switch user slugs before/after a join without
// importing two modules.
export { setUserSlug, getUserSlug };
