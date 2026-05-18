import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigPath,
  writeGitHubConfig,
  readPartialConfig,
  readPartialDecryptedConfig,
  loadConfig,
  preflightConfig,
  reencryptConfigUnderNewKey,
  saveCursors,
  flushCursors,
  saveLastSyncedAt,
  flushLastSyncedAt,
  type GitHubConfig,
} from "../config.js";

let tmpHome: string;
let origHome: string | undefined;
const masterKey = Buffer.alloc(32, 0x42);

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-github-config-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GOOD_CONFIG: GitHubConfig = {
  github_token: "ghp_TEST_TOKEN_xxxxxxxxxxxxxxxxxxxxxxxx",
  github_login: "chad",
  allowlisted_orgs: ["anthropics", "usrcp"],
  poll_interval_s: 600,
  domain: "github",
};

describe("round-trip encryption", () => {
  it("writes encrypted github_token; loadConfig decrypts back to plaintext", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(raw.github_login).toBe(GOOD_CONFIG.github_login); // not encrypted
    expect(raw.github_token.startsWith("enc:")).toBe(true);
    expect(raw.allowlisted_orgs).toEqual(GOOD_CONFIG.allowlisted_orgs);

    const loaded = loadConfig(masterKey);
    expect(loaded.github_token).toBe(GOOD_CONFIG.github_token);
    expect(loaded.github_login).toBe(GOOD_CONFIG.github_login);
    expect(loaded.allowlisted_orgs).toEqual(GOOD_CONFIG.allowlisted_orgs);
  });

  it("file is mode 0600 after write", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("readPartialConfig returns raw on-disk values (encrypted envelope)", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    const partial = readPartialConfig();
    expect(partial.github_token?.startsWith("enc:")).toBe(true);
  });

  it("loadConfig errors out when the master key cannot decrypt the on-disk envelope", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    const wrongKey = Buffer.alloc(32, 0xff);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(wrongKey)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("treats missing allowlisted_orgs as empty array (legacy compat)", () => {
    // Write a config with allowlisted_orgs explicitly omitted.
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const { allowlisted_orgs: _omit, ...minimal } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(minimal, null, 2), { mode: 0o600 });

    const loaded = loadConfig(masterKey);
    expect(loaded.allowlisted_orgs).toEqual([]);
  });
});

describe("readPartialDecryptedConfig (setup-wizard defaults)", () => {
  it("returns decrypted token so wizard 'Enter to keep' works on encrypted configs", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.github_token).toBe(GOOD_CONFIG.github_token);
    expect(decrypted.github_login).toBe(GOOD_CONFIG.github_login);
    expect(decrypted.allowlisted_orgs).toEqual(GOOD_CONFIG.allowlisted_orgs);
  });

  it("returns empty object when no config exists", () => {
    expect(readPartialDecryptedConfig(masterKey)).toEqual({});
  });

  it("passes through legacy plaintext values unchanged", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    const decrypted = readPartialDecryptedConfig(masterKey);
    expect(decrypted.github_token).toBe(GOOD_CONFIG.github_token);
  });
});

describe("preflightConfig (no master key required)", () => {
  it("exits when no config file exists", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when a required field is missing", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { github_login: _omit, ...bad } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(bad), { mode: 0o600 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => preflightConfig()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("returns normally on encrypted and on legacy-plaintext configs (no decryption performed)", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    expect(() => preflightConfig()).not.toThrow();

    fs.writeFileSync(getConfigPath(), JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });
    expect(() => preflightConfig()).not.toThrow();
  });
});

describe("legacy plaintext compat", () => {
  it("auto-migrates a pre-encryption plaintext config the moment loadConfig runs", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    const loaded = loadConfig(masterKey);
    expect(loaded.github_token).toBe(GOOD_CONFIG.github_token);

    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.github_token.startsWith("enc:")).toBe(true);

    const reloaded = loadConfig(masterKey);
    expect(reloaded.github_token).toBe(GOOD_CONFIG.github_token);
  });
});

describe("saveLastSyncedAt / flushLastSyncedAt (v1 deprecated aliases)", () => {
  it("still works as a thin wrapper over saveCursors", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    saveLastSyncedAt("2026-05-17T12:00:00.000Z", masterKey);
    saveLastSyncedAt("2026-05-17T12:00:01.000Z", masterKey);
    flushLastSyncedAt();

    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T12:00:01.000Z");
    expect(reloaded.github_token).toBe(GOOD_CONFIG.github_token);
  });

  it("bails if config was deleted at runtime - does not write back empty creds", () => {
    saveLastSyncedAt("2026-05-17T13:00:00.000Z", masterKey);
    fs.rmSync(getConfigPath(), { force: true });
    flushLastSyncedAt();
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe("saveCursors / flushCursors (v1.1)", () => {
  it("writes all five cursors when all advance in one tick", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    saveCursors(
      {
        last_synced_at: "2026-05-17T12:00:00.000Z",
        last_merged_at: "2026-05-17T13:00:00.000Z",
        last_closed_at: "2026-05-17T14:00:00.000Z",
        last_issue_opened_at: "2026-05-17T15:00:00.000Z",
        last_issue_commented_at: "2026-05-17T16:00:00.000Z",
      },
      masterKey,
    );
    flushCursors();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T12:00:00.000Z");
    expect(reloaded.last_merged_at).toBe("2026-05-17T13:00:00.000Z");
    expect(reloaded.last_closed_at).toBe("2026-05-17T14:00:00.000Z");
    expect(reloaded.last_issue_opened_at).toBe("2026-05-17T15:00:00.000Z");
    expect(reloaded.last_issue_commented_at).toBe("2026-05-17T16:00:00.000Z");
  });

  it("writes all three cursors when all three advance in one tick", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    saveCursors(
      {
        last_synced_at: "2026-05-17T12:00:00.000Z",
        last_merged_at: "2026-05-17T13:00:00.000Z",
        last_closed_at: "2026-05-17T14:00:00.000Z",
      },
      masterKey,
    );
    flushCursors();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T12:00:00.000Z");
    expect(reloaded.last_merged_at).toBe("2026-05-17T13:00:00.000Z");
    expect(reloaded.last_closed_at).toBe("2026-05-17T14:00:00.000Z");
  });

  it("writes only the cursors actually staged (others remain untouched)", () => {
    writeGitHubConfig(
      { ...GOOD_CONFIG, last_merged_at: "2026-05-10T00:00:00.000Z" },
      masterKey,
    );
    saveCursors({ last_synced_at: "2026-05-17T12:00:00.000Z" }, masterKey);
    flushCursors();
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBe("2026-05-17T12:00:00.000Z");
    // The merged cursor that was already on disk is preserved.
    expect(reloaded.last_merged_at).toBe("2026-05-10T00:00:00.000Z");
    expect(reloaded.last_closed_at).toBeUndefined();
  });

  it("coalesces multiple calls within the debounce window into one write per cursor", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    saveCursors({ last_merged_at: "2026-05-17T12:00:00.000Z" }, masterKey);
    saveCursors({ last_merged_at: "2026-05-17T12:00:05.000Z" }, masterKey);
    saveCursors({ last_closed_at: "2026-05-17T12:00:10.000Z" }, masterKey);
    flushCursors();
    const reloaded = loadConfig(masterKey);
    // Latest value wins for the same field.
    expect(reloaded.last_merged_at).toBe("2026-05-17T12:00:05.000Z");
    expect(reloaded.last_closed_at).toBe("2026-05-17T12:00:10.000Z");
  });

  it("resets pending state after flush so a second flush is a no-op", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    saveCursors({ last_synced_at: "2026-05-17T12:00:00.000Z" }, masterKey);
    flushCursors();
    // Mutate the file on disk; a second flush must NOT overwrite it.
    const updated = { ...readPartialConfig(), last_synced_at: "2030-01-01T00:00:00.000Z" };
    fs.writeFileSync(getConfigPath(), JSON.stringify(updated, null, 2), { mode: 0o600 });
    flushCursors();
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).last_synced_at).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });

  it("bails if config was deleted at runtime", () => {
    saveCursors({ last_merged_at: "2026-05-17T13:00:00.000Z" }, masterKey);
    fs.rmSync(getConfigPath(), { force: true });
    flushCursors();
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("does nothing when no cursors are staged", () => {
    writeGitHubConfig(GOOD_CONFIG, masterKey);
    flushCursors(); // nothing staged
    const reloaded = loadConfig(masterKey);
    expect(reloaded.last_synced_at).toBeUndefined();
    expect(reloaded.last_merged_at).toBeUndefined();
    expect(reloaded.last_closed_at).toBeUndefined();
  });
});

describe("reencryptConfigUnderNewKey (rotate-key hook)", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  it("returns 'absent' when no config exists", () => {
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("absent");
  });

  it("rewrites an encrypted config so the new key (and only the new key) can decrypt it", () => {
    writeGitHubConfig(GOOD_CONFIG, oldKey);
    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");

    const reloaded = loadConfig(newKey);
    expect(reloaded.github_token).toBe(GOOD_CONFIG.github_token);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(oldKey)).toThrow("process.exit called");
    exitSpy.mockRestore();
  });

  it("migrates a legacy plaintext config to encrypted under the new key", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify(GOOD_CONFIG, null, 2), { mode: 0o600 });

    expect(reencryptConfigUnderNewKey(oldKey, newKey)).toBe("rotated");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.github_token.startsWith("enc:")).toBe(true);
    expect(loadConfig(newKey).github_token).toBe(GOOD_CONFIG.github_token);
  });

  it("preserves mode 0600 after rotation", () => {
    writeGitHubConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("throws when the on-disk config is missing the github_token field", () => {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const { github_token: _omit, ...incomplete } = GOOD_CONFIG;
    fs.writeFileSync(p, JSON.stringify(incomplete), { mode: 0o600 });
    expect(() => reencryptConfigUnderNewKey(oldKey, newKey)).toThrow(/incomplete github config/);
  });

  it("leaves no .rotate-tmp.* leftovers after a successful rotation", () => {
    writeGitHubConfig(GOOD_CONFIG, oldKey);
    reencryptConfigUnderNewKey(oldKey, newKey);
    const configDir = path.dirname(getConfigPath());
    const leftovers = fs.readdirSync(configDir).filter((n) => n.includes(".rotate-tmp."));
    expect(leftovers).toEqual([]);
  });
});
