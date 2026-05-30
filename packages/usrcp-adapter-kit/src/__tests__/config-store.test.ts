import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createAdapterConfig } from "../config-store.js";

// A representative single-secret poll adapter (linear-shaped).
interface DemoConfig extends Record<string, unknown> {
  demo_api_key: string;
  allowlisted_ids: string[];
  domain: string;
  poll_interval_s: number;
  last_synced_at?: string;
}

function makeStore() {
  return createAdapterConfig<DemoConfig>({
    adapterName: "demo",
    filename: "demo-config.json",
    fields: [
      { name: "demo_api_key", kind: "secret" },
      { name: "allowlisted_ids", kind: "requiredNonEmptyArray" },
      { name: "domain", kind: "required" },
      { name: "poll_interval_s", kind: "requiredNumber" },
      { name: "last_synced_at", kind: "optional" },
    ],
    cursorFields: ["last_synced_at"],
  });
}

// A two-secret OAuth adapter (gmail-shaped).
interface OAuthConfig extends Record<string, unknown> {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
  domain: string;
  poll_interval_s: number;
  last_synced_at?: string;
}

function makeOAuthStore() {
  return createAdapterConfig<OAuthConfig>({
    adapterName: "oauthdemo",
    filename: "oauthdemo-config.json",
    fields: [
      { name: "oauth_client_id", kind: "required" },
      { name: "oauth_client_secret", kind: "secret" },
      { name: "refresh_token", kind: "secret" },
      { name: "domain", kind: "required" },
      { name: "poll_interval_s", kind: "requiredNumber" },
      { name: "last_synced_at", kind: "optional" },
    ],
    cursorFields: ["last_synced_at"],
  });
}

let tmpHome: string;
let origHome: string | undefined;
const KEY = crypto.randomBytes(32);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-kit-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const DEMO: DemoConfig = {
  demo_api_key: "sk-secret-123",
  allowlisted_ids: ["a", "b"],
  domain: "coding",
  poll_interval_s: 600,
};

describe("encrypt-at-rest", () => {
  it("writeConfig encrypts secret fields and never writes plaintext", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    const raw = fs.readFileSync(store.getConfigPath(), "utf8");
    // Secret is enveloped; the plaintext value is absent from disk.
    expect(raw).not.toContain("sk-secret-123");
    const onDisk = JSON.parse(raw);
    expect(onDisk.demo_api_key).toMatch(/^enc:/);
    // Non-secret fields are stored in the clear.
    expect(onDisk.domain).toBe("coding");
    expect(onDisk.allowlisted_ids).toEqual(["a", "b"]);
  });

  it("writes the config file at mode 0600", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    const mode = fs.statSync(store.getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("encrypts every secret for a multi-secret adapter", () => {
    const store = makeOAuthStore();
    store.writeConfig(
      {
        oauth_client_id: "client-id-public",
        oauth_client_secret: "CLIENT_SECRET",
        refresh_token: "REFRESH_TOKEN",
        domain: "mail",
        poll_interval_s: 600,
      },
      KEY,
    );
    const raw = fs.readFileSync(store.getConfigPath(), "utf8");
    expect(raw).not.toContain("CLIENT_SECRET");
    expect(raw).not.toContain("REFRESH_TOKEN");
    const onDisk = JSON.parse(raw);
    expect(onDisk.oauth_client_secret).toMatch(/^enc:/);
    expect(onDisk.refresh_token).toMatch(/^enc:/);
    // Non-secret id stays clear.
    expect(onDisk.oauth_client_id).toBe("client-id-public");
  });
});

describe("loadConfig", () => {
  it("round-trips: write then load returns the plaintext secret", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    const loaded = store.loadConfig(KEY);
    expect(loaded.demo_api_key).toBe("sk-secret-123");
    expect(loaded.domain).toBe("coding");
    expect(loaded.poll_interval_s).toBe(600);
  });

  it("auto-migrates a legacy plaintext config on load (re-encrypts to disk)", () => {
    const store = makeStore();
    // Plant a legacy plaintext config (secret not enc:-enveloped).
    store.writeRaw({ ...DEMO });
    expect(fs.readFileSync(store.getConfigPath(), "utf8")).toContain(
      "sk-secret-123",
    );
    const loaded = store.loadConfig(KEY);
    expect(loaded.demo_api_key).toBe("sk-secret-123");
    // After load, the on-disk secret is encrypted.
    const onDisk = JSON.parse(fs.readFileSync(store.getConfigPath(), "utf8"));
    expect(onDisk.demo_api_key).toMatch(/^enc:/);
  });

  it("does NOT auto-migrate when migrateLegacyOnLoad is false", () => {
    const store = createAdapterConfig<DemoConfig>({
      adapterName: "demo",
      filename: "demo-config.json",
      fields: [
        { name: "demo_api_key", kind: "secret" },
        { name: "allowlisted_ids", kind: "requiredNonEmptyArray" },
        { name: "domain", kind: "required" },
        { name: "poll_interval_s", kind: "requiredNumber" },
      ],
      migrateLegacyOnLoad: false,
    });
    store.writeRaw({ ...DEMO });
    store.loadConfig(KEY);
    // Still plaintext — no migration write happened.
    expect(fs.readFileSync(store.getConfigPath(), "utf8")).toContain(
      "sk-secret-123",
    );
  });

  it("applies defaults for optional fields absent on disk", () => {
    interface WithDefault extends Record<string, unknown> {
      token: string;
      domain: string;
      poll_interval_s: number;
      allowlisted_orgs: string[];
    }
    const store = createAdapterConfig<WithDefault>({
      adapterName: "demo",
      filename: "demo-config.json",
      fields: [
        { name: "token", kind: "secret" },
        { name: "domain", kind: "required" },
        { name: "poll_interval_s", kind: "requiredNumber" },
        { name: "allowlisted_orgs", kind: "optional", default: [] },
      ],
    });
    store.writeRaw({ token: "enc-me", domain: "coding", poll_interval_s: 600 });
    const loaded = store.loadConfig(KEY);
    expect(loaded.allowlisted_orgs).toEqual([]);
  });

  it("process.exit(1) on missing required fields", () => {
    const store = makeStore();
    store.writeRaw({ domain: "coding" }); // missing secret, array, number
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("EXIT");
      }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.loadConfig(KEY)).toThrow("EXIT");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("missingRequiredFields", () => {
  it("reports missing fields in declared order", () => {
    const store = makeStore();
    expect(store.missingRequiredFields({})).toEqual([
      "demo_api_key",
      "allowlisted_ids",
      "domain",
      "poll_interval_s",
    ]);
  });

  it("treats an empty array as missing for requiredNonEmptyArray", () => {
    const store = makeStore();
    const missing = store.missingRequiredFields({
      demo_api_key: "x",
      allowlisted_ids: [],
      domain: "coding",
      poll_interval_s: 600,
    });
    expect(missing).toEqual(["allowlisted_ids"]);
  });

  it("treats a non-number as missing for requiredNumber", () => {
    const store = makeStore();
    const missing = store.missingRequiredFields({
      demo_api_key: "x",
      allowlisted_ids: ["a"],
      domain: "coding",
      poll_interval_s: "600" as unknown as number,
    });
    expect(missing).toEqual(["poll_interval_s"]);
  });

  it("returns [] for a complete config", () => {
    const store = makeStore();
    expect(store.missingRequiredFields(DEMO)).toEqual([]);
  });
});

describe("reencryptConfigUnderNewKey", () => {
  it("returns 'absent' when no config exists", () => {
    const store = makeStore();
    expect(store.reencryptConfigUnderNewKey(KEY, crypto.randomBytes(32))).toBe(
      "absent",
    );
  });

  it("re-encrypts secrets so they load under the new key only", () => {
    const store = makeStore();
    const newKey = crypto.randomBytes(32);
    store.writeConfig(DEMO, KEY);
    expect(store.reencryptConfigUnderNewKey(KEY, newKey)).toBe("rotated");
    // Loads under the new key...
    expect(store.loadConfig(newKey).demo_api_key).toBe("sk-secret-123");
    // ...and the old key can no longer decrypt (GCM auth failure → exit).
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("EXIT");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.loadConfig(KEY)).toThrow("EXIT");
  });

  it("throws when a secret is absent (incomplete config)", () => {
    const store = makeStore();
    store.writeRaw({ domain: "coding" });
    expect(() =>
      store.reencryptConfigUnderNewKey(KEY, crypto.randomBytes(32)),
    ).toThrow(/incomplete demo config/);
  });
});

describe("debounced cursor persistence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces saves and writes the cursor after the debounce window", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    store.saveCursors({ last_synced_at: "2026-01-01T00:00:00Z" }, KEY);
    store.saveCursors({ last_synced_at: "2026-02-02T00:00:00Z" }, KEY);
    // Nothing written yet.
    expect(store.readPartialConfig().last_synced_at).toBeUndefined();
    vi.advanceTimersByTime(500);
    // Only the latest value hits disk; secret stays encrypted.
    const onDisk = store.readPartialConfig();
    expect(onDisk.last_synced_at).toBe("2026-02-02T00:00:00Z");
    expect(String(onDisk.demo_api_key)).toMatch(/^enc:/);
  });

  it("bails (does not write) when the on-disk config is stripped", () => {
    const store = makeStore();
    store.writeRaw({ domain: "coding" }); // incomplete: no secret/array/number
    store.saveCursors({ last_synced_at: "2026-01-01T00:00:00Z" }, KEY);
    vi.advanceTimersByTime(500);
    // Cursor was not written onto the incomplete config.
    expect(store.readPartialConfig().last_synced_at).toBeUndefined();
  });

  it("flushCursors writes immediately", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    store.saveCursors({ last_synced_at: "2026-03-03T00:00:00Z" }, KEY);
    store.flushCursors();
    expect(store.readPartialConfig().last_synced_at).toBe(
      "2026-03-03T00:00:00Z",
    );
  });
});

describe("writeRaw / readPartialDecryptedConfig", () => {
  it("writeRaw writes verbatim (no encryption) at mode 0600", () => {
    const store = makeStore();
    store.writeRaw({ demo_api_key: "plain", domain: "coding" });
    const raw = fs.readFileSync(store.getConfigPath(), "utf8");
    expect(JSON.parse(raw).demo_api_key).toBe("plain");
    expect(fs.statSync(store.getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialDecryptedConfig returns the decrypted secret", () => {
    const store = makeStore();
    store.writeConfig(DEMO, KEY);
    const dec = store.readPartialDecryptedConfig(KEY);
    expect(dec.demo_api_key).toBe("sk-secret-123");
  });
});
