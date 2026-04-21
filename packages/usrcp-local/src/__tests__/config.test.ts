import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setUserSlug } from "../encryption.js";
import { readConfig, writeConfig, updateConfig, getConfigPath } from "../config.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-config-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("config", () => {
  it("returns empty object on fresh install", () => {
    expect(readConfig()).toEqual({});
  });

  it("writeConfig persists and readConfig round-trips", () => {
    writeConfig({ cloud_endpoint: "https://example.com", last_push_local_seq: 42 });
    const read = readConfig();
    expect(read.cloud_endpoint).toBe("https://example.com");
    expect(read.last_push_local_seq).toBe(42);
  });

  it("updateConfig merges without clobbering unrelated keys", () => {
    writeConfig({ cloud_endpoint: "https://a", last_push_local_seq: 5 });
    updateConfig({ last_push_local_seq: 10 });
    const cfg = readConfig();
    expect(cfg.cloud_endpoint).toBe("https://a");
    expect(cfg.last_push_local_seq).toBe(10);
  });

  it("is per-user — alice's config is invisible to bob", () => {
    setUserSlug("alice");
    writeConfig({ cloud_endpoint: "https://alice" });
    setUserSlug("bob");
    expect(readConfig()).toEqual({});
    writeConfig({ cloud_endpoint: "https://bob" });

    setUserSlug("alice");
    expect(readConfig().cloud_endpoint).toBe("https://alice");
    setUserSlug("bob");
    expect(readConfig().cloud_endpoint).toBe("https://bob");
  });

  it("file mode is 0600 on Unix", () => {
    writeConfig({ cloud_endpoint: "x" });
    if (process.platform !== "win32") {
      const mode = fs.statSync(getConfigPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
