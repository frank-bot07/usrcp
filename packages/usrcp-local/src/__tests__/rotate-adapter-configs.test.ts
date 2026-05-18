/**
 * Tests for the adapter-config re-encryption dispatcher that runs as
 * part of `usrcp_rotate_key`.
 *
 * Strategy: drive the dispatcher with a fake adapter module so we
 * don't need any of the real adapter packages built into a specific
 * location. The shape of the fake matches the real per-adapter
 * helper: `reencryptConfigUnderNewKey(oldKey, newKey): "absent" | "rotated"`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  reencryptAdapterConfigs,
  ADAPTERS_WITH_ENCRYPTED_CONFIG,
} from "../rotate-adapter-configs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-rotate-dispatcher-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Write a fake "adapter package" config.js to disk that exports a
 * spyable reencryptConfigUnderNewKey. Each fake records its calls in
 * a shared registry the test can introspect.
 */
function writeFakeAdapter(opts: {
  adapter: string;
  behavior: "rotated" | "absent" | "throw";
  /** Distinct module path - the dispatcher loads via require. */
  baseDir: string;
}): string {
  const modDir = path.join(opts.baseDir, `usrcp-${opts.adapter}`, "dist");
  fs.mkdirSync(modDir, { recursive: true });
  const modulePath = path.join(modDir, "config.js");

  let body: string;
  if (opts.behavior === "throw") {
    body = `
      module.exports.reencryptConfigUnderNewKey = function() {
        throw new Error("simulated decrypt failure for ${opts.adapter}");
      };
    `;
  } else {
    body = `
      module.exports.reencryptConfigUnderNewKey = function(oldKey, newKey) {
        // Sanity: keys MUST be Buffers (caught a real bug previously).
        if (!Buffer.isBuffer(oldKey) || !Buffer.isBuffer(newKey)) {
          throw new Error("expected Buffer keys");
        }
        return "${opts.behavior}";
      };
    `;
  }
  fs.writeFileSync(modulePath, body);
  return modulePath;
}

describe("reencryptAdapterConfigs", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  it("returns empty result when no adapters are listed", () => {
    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: [],
    });
    expect(result).toEqual({ rotated: [], absent: [], failed: [] });
  });

  it("partitions adapters into rotated / absent / failed", () => {
    writeFakeAdapter({ adapter: "google-calendar", behavior: "rotated", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "gmail", behavior: "rotated", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "linear", behavior: "absent", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "discord", behavior: "throw", baseDir: tmpDir });

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["google-calendar", "gmail", "linear", "discord"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated.sort()).toEqual(["gmail", "google-calendar"]);
    expect(result.absent).toEqual(["linear"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].adapter).toBe("discord");
    expect(result.failed[0].reason).toContain("simulated decrypt failure");
  });

  it("silently skips adapter packages that aren't installed", () => {
    // Only build one fake; the dispatcher should skip the rest cleanly.
    writeFakeAdapter({ adapter: "linear", behavior: "rotated", baseDir: tmpDir });

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["linear", "gmail", "telegram"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated).toEqual(["linear"]);
    expect(result.absent).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("reports a missing export as a failure (not a silent no-op)", () => {
    const modDir = path.join(tmpDir, "usrcp-slack", "dist");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "config.js"),
      `module.exports.somethingElse = function() {};`,
    );

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["slack"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].adapter).toBe("slack");
    expect(result.failed[0].reason).toContain("does not export reencryptConfigUnderNewKey");
  });

  it("a failure in one adapter does NOT stop subsequent adapters", () => {
    writeFakeAdapter({ adapter: "discord", behavior: "throw", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "telegram", behavior: "rotated", baseDir: tmpDir });

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["discord", "telegram"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated).toEqual(["telegram"]);
    expect(result.failed.map((f) => f.adapter)).toEqual(["discord"]);
  });

  it("passes the keys through as Buffers (regression: was masterKey-undefined bug in #54)", () => {
    let observedOld: unknown;
    let observedNew: unknown;
    const modDir = path.join(tmpDir, "usrcp-gmail", "dist");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "config.js"),
      `
      const fs = require("node:fs");
      module.exports.reencryptConfigUnderNewKey = function(oldKey, newKey) {
        fs.writeFileSync(${JSON.stringify(path.join(tmpDir, "observed.json"))}, JSON.stringify({
          oldIsBuffer: Buffer.isBuffer(oldKey),
          oldLen: oldKey && oldKey.length,
          newIsBuffer: Buffer.isBuffer(newKey),
          newLen: newKey && newKey.length,
        }));
        return "rotated";
      };
      `,
    );

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["gmail"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated).toEqual(["gmail"]);
    const observed = JSON.parse(fs.readFileSync(path.join(tmpDir, "observed.json"), "utf8"));
    expect(observed).toEqual({
      oldIsBuffer: true,
      oldLen: 32,
      newIsBuffer: true,
      newLen: 32,
    });
    void observedOld; void observedNew;
  });
});

describe("ADAPTERS_WITH_ENCRYPTED_CONFIG", () => {
  it("matches the master-key-requiring adapter set", () => {
    // Sanity that we don't forget to keep these in sync. The
    // setup-time list is in setup.ts:ADAPTERS_REQUIRING_MASTER_KEY;
    // the rotate-time list is here. Any adapter that encrypts at
    // setup must also re-encrypt at rotate.
    expect(new Set(ADAPTERS_WITH_ENCRYPTED_CONFIG)).toEqual(
      new Set(["google-calendar", "gmail", "linear", "discord", "slack", "telegram", "github"]),
    );
  });
});
