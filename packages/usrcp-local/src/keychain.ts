/**
 * USRCP OS Keychain Integration
 *
 * Stores the ledger passphrase in the operating system's credential store so
 * MCP clients (Claude Desktop, Cursor, Cline, ...) can auto-start the server
 * without the user baking USRCP_PASSPHRASE in plaintext into editor JSON
 * configs — previously the documented (and worst) part of passphrase-mode UX.
 *
 * Backends, chosen by platform:
 * - macOS:  `security` (login Keychain). Commands are fed via `security -i`
 *           stdin so the passphrase never appears in the process list.
 * - Linux:  `secret-tool` (freedesktop Secret Service / GNOME Keyring /
 *           KWallet). The secret is passed on stdin.
 * - Windows: not yet supported (no bundled CLI for Credential Manager).
 *
 * Threat-model note: the keychain protects the passphrase at rest (encrypted
 * by the OS, gated on the user's login session). It does NOT change the §8
 * caveats in docs/SECURITY.md — any process running as the logged-in user
 * that can drive the keychain CLI can read the entry, just as it could read
 * USRCP_PASSPHRASE from a config file or the server's heap. The win over the
 * env-var-in-editor-config pattern is strictly: nothing in plaintext on disk,
 * and OS-level access prompts/auditing apply.
 *
 * Encoding: the stored secret is `usrcp-b64:<base64(passphrase)>`. Both CLI
 * backends are lossy/ambiguous for raw values — macOS `security
 * find-generic-password -w` prints the secret HEX-ENCODED whenever it
 * contains non-ASCII bytes (verified empirically: "ünïcode" comes back as
 * "c3bc6e..."), and the `security -i` parser has its own quoting rules.
 * Base64 with a self-describing prefix round-trips byte-faithfully through
 * both backends and any passphrase the env-var path accepts. Entries WITHOUT
 * the prefix are returned verbatim, so a user who manually runs
 * `security add-generic-password -s usrcp -a <slug> -w "phrase"` still works.
 *
 * Every store is additionally round-trip verified (write, read back,
 * compare). A failed verification deletes the entry and throws rather than
 * leaving a corrupt credential behind.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";

/** Keychain service name shared by all USRCP entries; account = user slug. */
const SERVICE = "usrcp";

/**
 * Timeouts so a locked or misconfigured keychain degrades to a clear error
 * instead of hanging the caller. This matters most for `usrcp serve` spawned
 * headlessly by an MCP client: `security` can block forever waiting on a GUI
 * unlock dialog (or, with a broken HOME, on a keychain that will never
 * appear). Reads fail fast — serve falls back to the env-var error message.
 * Stores get longer because the user may legitimately be answering an
 * unlock prompt.
 */
const DETECT_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 15_000;
const STORE_TIMEOUT_MS = 60_000;

/** True when a spawnSync result means the process timed out or died on a signal. */
function spawnFailedAbnormally(r: { error?: Error; signal: NodeJS.Signals | null }): boolean {
  return Boolean(r.error) || r.signal !== null;
}

export type KeychainBackend = "macos-keychain" | "secret-service";

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

export interface KeychainAvailability {
  available: boolean;
  backend: KeychainBackend | null;
  /** Human-readable explanation when unavailable. */
  reason?: string;
}

/** Self-describing prefix for base64-encoded secrets (see module docs). */
const B64_PREFIX = "usrcp-b64:";

function label(slug: string): string {
  return `USRCP passphrase (${slug})`;
}

function encodeSecret(passphrase: string): string {
  return B64_PREFIX + Buffer.from(passphrase, "utf-8").toString("base64");
}

function decodeSecret(stored: string): string {
  if (!stored.startsWith(B64_PREFIX)) return stored; // manually-created plain entry
  return Buffer.from(stored.slice(B64_PREFIX.length), "base64").toString("utf-8");
}

function hasBinary(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf-8", timeout: DETECT_TIMEOUT_MS });
  return r.status === 0;
}

/**
 * Detect whether an OS keychain backend is usable on this machine.
 * Cheap enough to call ad hoc; no caching so tests and long-lived
 * processes always see the live state.
 */
export function detectKeychain(): KeychainAvailability {
  if (process.platform === "darwin") {
    if (hasBinary("security")) {
      return { available: true, backend: "macos-keychain" };
    }
    return {
      available: false,
      backend: null,
      reason: "`security` CLI not found (expected at /usr/bin/security).",
    };
  }
  if (process.platform === "linux") {
    if (hasBinary("secret-tool")) {
      return { available: true, backend: "secret-service" };
    }
    return {
      available: false,
      backend: null,
      reason:
        "`secret-tool` not found. Install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch).",
    };
  }
  return {
    available: false,
    backend: null,
    reason: `OS keychain not supported on ${process.platform} yet.`,
  };
}

/**
 * Quote a value for the `security -i` interactive parser: wrap in double
 * quotes, escape backslashes and double quotes. The secret itself is always
 * base64 (ASCII-safe); this guards the service/account/label strings.
 */
function securityQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Refuse values that make no sense to store. Base64 encoding makes any
 * non-empty passphrase storable, including ones with quotes, unicode, or
 * control characters — anything the USRCP_PASSPHRASE env-var path accepts.
 */
export function validatePassphraseStorable(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new KeychainError("Refusing to store an empty passphrase.");
  }
}

/**
 * Read the stored passphrase for a user slug.
 * Returns null when no entry exists (or the secret service is locked/absent);
 * throws KeychainError only on unexpected failures.
 */
export function readPassphraseFromKeychain(slug: string): string | null {
  const k = detectKeychain();
  if (!k.available) return null;

  if (k.backend === "macos-keychain") {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", slug, "-w"],
      { encoding: "utf-8", timeout: READ_TIMEOUT_MS }
    );
    // Timed out (e.g. locked keychain waiting on a GUI dialog) or killed:
    // treat as "no entry" so callers fall back to the env-var workflow.
    if (spawnFailedAbnormally(r)) return null;
    // 44 = errSecItemNotFound
    if (r.status === 44) return null;
    if (r.status !== 0) return null;
    // -w prints the password followed by a newline
    const raw = (r.stdout ?? "").replace(/\n$/, "");
    return raw ? decodeSecret(raw) : null;
  }

  // secret-service
  const r = spawnSync(
    "secret-tool",
    ["lookup", "service", SERVICE, "account", slug],
    { encoding: "utf-8", timeout: READ_TIMEOUT_MS }
  );
  if (spawnFailedAbnormally(r)) return null;
  if (r.status !== 0) return null;
  const raw = (r.stdout ?? "").replace(/\n$/, "");
  return raw ? decodeSecret(raw) : null;
}

/**
 * Store (or replace) the passphrase for a user slug, then round-trip verify.
 * Throws KeychainError on any failure; on verification mismatch the entry is
 * deleted so a corrupt credential is never left behind.
 */
export function storePassphraseInKeychain(slug: string, passphrase: string): KeychainBackend {
  validatePassphraseStorable(passphrase);
  const k = detectKeychain();
  if (!k.available || !k.backend) {
    throw new KeychainError(k.reason ?? "No OS keychain backend available.");
  }

  const secret = encodeSecret(passphrase);

  if (k.backend === "macos-keychain") {
    // -U updates an existing item in place. Feeding the command via `-i`
    // stdin keeps the passphrase out of the process list (ps/Activity
    // Monitor), unlike passing -w as an argv element. The base64 secret is
    // ASCII-safe for the -i parser; quoting guards the service/label text.
    const cmd =
      `add-generic-password -U -s ${securityQuote(SERVICE)} -a ${securityQuote(slug)} ` +
      `-l ${securityQuote(label(slug))} -w ${securityQuote(secret)}\n`;
    const r = spawnSync("security", ["-i"], { input: cmd, encoding: "utf-8", timeout: STORE_TIMEOUT_MS });
    if (spawnFailedAbnormally(r)) {
      throw new KeychainError(
        "security did not respond (timed out) — is the login keychain locked or unavailable? " +
          "Unlock it (Keychain Access, or `security unlock-keychain`) and retry."
      );
    }
    if (r.status !== 0) {
      throw new KeychainError(
        `security add-generic-password failed (exit ${r.status}): ${(r.stderr ?? "").trim()}`
      );
    }
  } else {
    const r = spawnSync(
      "secret-tool",
      ["store", `--label=${label(slug)}`, "service", SERVICE, "account", slug],
      { input: secret, encoding: "utf-8", timeout: STORE_TIMEOUT_MS }
    );
    if (spawnFailedAbnormally(r)) {
      throw new KeychainError(
        "secret-tool did not respond (timed out) — is the Secret Service daemon running and unlocked?"
      );
    }
    if (r.status !== 0) {
      throw new KeychainError(
        `secret-tool store failed (exit ${r.status}): ${(r.stderr ?? "").trim()}. ` +
          "Is a Secret Service daemon (gnome-keyring / KWallet) running and unlocked?"
      );
    }
  }

  // Round-trip verify. Catches backend quirks (e.g. macOS `security`
  // treating hex-looking passwords as raw bytes) before the user depends
  // on the entry to unlock their ledger.
  const back = readPassphraseFromKeychain(slug);
  const a = Buffer.from(passphrase, "utf-8");
  const b = Buffer.from(back ?? "", "utf-8");
  if (back === null || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    clearPassphraseFromKeychain(slug);
    throw new KeychainError(
      "Keychain round-trip verification failed — the backend did not store the passphrase faithfully. " +
        "The entry has been removed. Keep using USRCP_PASSPHRASE for this passphrase."
    );
  }
  return k.backend;
}

/**
 * Remove the stored passphrase for a user slug.
 * Returns true if an entry was removed, false if none existed.
 */
export function clearPassphraseFromKeychain(slug: string): boolean {
  const k = detectKeychain();
  if (!k.available) return false;

  if (k.backend === "macos-keychain") {
    const r = spawnSync(
      "security",
      ["delete-generic-password", "-s", SERVICE, "-a", slug],
      { encoding: "utf-8", timeout: READ_TIMEOUT_MS }
    );
    return !spawnFailedAbnormally(r) && r.status === 0;
  }

  const r = spawnSync(
    "secret-tool",
    ["clear", "service", SERVICE, "account", slug],
    { encoding: "utf-8", timeout: READ_TIMEOUT_MS }
  );
  return !spawnFailedAbnormally(r) && r.status === 0;
}
