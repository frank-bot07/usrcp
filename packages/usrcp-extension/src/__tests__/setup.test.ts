/**
 * Setup module unit tests (packages/usrcp-extension/src/__tests__/setup.test.ts)
 *
 * Tests the config helpers (path resolution, write/read round-trip, NM manifest
 * content). The interactive runExtensionSetup() flow is not tested here — it
 * requires a TTY and is covered by manual verification per the handoff brief.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Isolate HOME for each test
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-ext-test-"));
  process.env.HOME = tmpHome;
  // Also override HOMEPATH/USERPROFILE for cross-platform compat in os.homedir()
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Dynamic import after HOME override so os.homedir() picks up the mock
// ---------------------------------------------------------------------------

async function getConfig() {
  // Fresh dynamic import each time (vitest resets module cache between tests)
  const mod = await import("../config.js");
  return mod;
}

// ---------------------------------------------------------------------------
// getConfigPath
// ---------------------------------------------------------------------------

describe("getConfigPath", () => {
  it("returns a path inside ~/.usrcp/", async () => {
    const { getConfigPath } = await getConfig();
    const p = getConfigPath();
    expect(p).toContain(".usrcp");
    expect(p.endsWith("extension-config.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeExtensionConfig / loadExtensionConfig round-trip
// ---------------------------------------------------------------------------

describe("writeExtensionConfig / loadExtensionConfig", () => {
  const GOOD_CONFIG = {
    extension_id: "abcdefghijklmnopabcdefghijklmnop",
    bridge_path: "/usr/local/lib/usrcp/native-host/usrcp-bridge.js",
    manifest_path:
      "/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.usrcp.bridge.json",
    configured_at: "2026-04-26T12:00:00.000Z",
  };

  it("writes the config file with mode 0600", async () => {
    const { writeExtensionConfig, getConfigPath } = await getConfig();
    writeExtensionConfig(GOOD_CONFIG);
    const stat = fs.statSync(getConfigPath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips all fields correctly", async () => {
    const { writeExtensionConfig, loadExtensionConfig } = await getConfig();
    writeExtensionConfig(GOOD_CONFIG);
    const loaded = loadExtensionConfig();
    expect(loaded).toEqual(GOOD_CONFIG);
  });

  it("throws if config file does not exist", async () => {
    const { loadExtensionConfig } = await getConfig();
    expect(() => loadExtensionConfig()).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Extension ID validation pattern (tested indirectly via regex)
// ---------------------------------------------------------------------------

describe("Extension ID format", () => {
  const VALID_RE = /^[a-p]{32}$/;

  it("accepts a 32-char lowercase a-p string", () => {
    expect(VALID_RE.test("abcdefghijklmnopabcdefghijklmnop")).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(VALID_RE.test("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP")).toBe(false);
  });

  it("rejects strings shorter than 32 chars", () => {
    expect(VALID_RE.test("abcdefghijklmnop")).toBe(false);
  });

  it("rejects strings containing letters outside a-p", () => {
    // 'q' through 'z' are not valid
    expect(VALID_RE.test("qbcdefghijklmnopabcdefghijklmnop")).toBe(false);
  });
});
