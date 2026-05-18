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
  resumeAdapterRotationIfPending,
  ADAPTERS_WITH_ENCRYPTED_CONFIG,
  ADAPTER_ROTATION_CHECKPOINT_V,
  type AdapterRotationCheckpoint,
} from "../rotate-adapter-configs.js";
import { decrypt, deriveGlobalEncryptionKey, encrypt } from "../encryption.js";

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

describe("checkpoint + resume (PR #67 - Codex Tier-1 #3)", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);

  function setupUserDir(): { userDir: string; checkpointPath: string } {
    const userDir = path.join(tmpDir, "user");
    fs.mkdirSync(path.join(userDir, "keys"), { recursive: true, mode: 0o700 });
    return { userDir, checkpointPath: path.join(userDir, "keys", "adapter-rotation.json") };
  }

  it("writes a checkpoint at the start of the loop and removes it on success", () => {
    const { userDir, checkpointPath } = setupUserDir();
    writeFakeAdapter({ adapter: "gmail", behavior: "rotated", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "linear", behavior: "rotated", baseDir: tmpDir });

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["gmail", "linear"],
      userDir,
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated.sort()).toEqual(["gmail", "linear"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("never writes a checkpoint when userDir is not provided (backward compat)", () => {
    writeFakeAdapter({ adapter: "gmail", behavior: "rotated", baseDir: tmpDir });

    const result = reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["gmail"],
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result.rotated).toEqual(["gmail"]);
    // Nothing in the tmpDir tree under a "keys/" prefix.
    const allFiles = fs.readdirSync(tmpDir, { recursive: true }) as string[];
    expect(allFiles.some((f) => String(f).includes("adapter-rotation.json"))).toBe(false);
  });

  it("checkpoint old_key_enc decrypts under the NEW global key (recovery seed)", () => {
    const { userDir, checkpointPath } = setupUserDir();
    // Build an adapter that, on first call, leaves a sentinel and
    // halts processing, so we can capture the checkpoint mid-flight.
    const modDir = path.join(tmpDir, "usrcp-gmail", "dist");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "config.js"),
      `
        const fs = require("node:fs");
        module.exports.reencryptConfigUnderNewKey = function() {
          // Snapshot the checkpoint as it exists during the loop body.
          fs.copyFileSync(
            ${JSON.stringify(checkpointPath)},
            ${JSON.stringify(path.join(tmpDir, "mid-loop-checkpoint.json"))}
          );
          throw new Error("halt-after-checkpoint-snapshot");
        };
      `,
    );

    reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["gmail"],
      userDir,
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    const mid = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "mid-loop-checkpoint.json"), "utf-8")
    ) as AdapterRotationCheckpoint;
    expect(mid.v).toBe(ADAPTER_ROTATION_CHECKPOINT_V);
    expect(mid.pending).toEqual(["gmail"]);
    expect(mid.old_key_enc).toMatch(/^enc:/);

    const globalKey = deriveGlobalEncryptionKey(newKey);
    const recoveredOldB64 = decrypt(mid.old_key_enc, globalKey);
    expect(Buffer.from(recoveredOldB64, "base64").equals(oldKey)).toBe(true);
  });

  it("records partial state in the checkpoint as adapters complete (visible to a parallel reader)", () => {
    const { userDir, checkpointPath } = setupUserDir();
    writeFakeAdapter({ adapter: "first", behavior: "rotated", baseDir: tmpDir });

    // Use the adapter call as the trigger to snapshot the checkpoint
    // file mid-loop. After "first" rotates, second has not yet
    // started, so the checkpoint should have first in `completed`
    // and second still in `pending`.
    const modDir = path.join(tmpDir, "usrcp-second", "dist");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "config.js"),
      `
        const fs = require("node:fs");
        module.exports.reencryptConfigUnderNewKey = function() {
          fs.copyFileSync(
            ${JSON.stringify(checkpointPath)},
            ${JSON.stringify(path.join(tmpDir, "snapshot.json"))}
          );
          return "rotated";
        };
      `,
    );

    reencryptAdapterConfigs({
      oldKey,
      newKey,
      adapters: ["first", "second"],
      userDir,
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    // After the dispatcher returns, the checkpoint is gone.
    expect(fs.existsSync(checkpointPath)).toBe(false);
    // But the in-flight snapshot captured the partial state.
    const snap = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "snapshot.json"), "utf-8")
    ) as AdapterRotationCheckpoint;
    expect(snap.completed.map((c) => c.adapter)).toEqual(["first"]);
    expect(snap.pending).toEqual(["second"]);
  });

  it("resumeAdapterRotationIfPending decrypts old_key and processes pending adapters", () => {
    const { userDir, checkpointPath } = setupUserDir();
    writeFakeAdapter({ adapter: "gmail", behavior: "rotated", baseDir: tmpDir });
    writeFakeAdapter({ adapter: "linear", behavior: "rotated", baseDir: tmpDir });

    // Hand-craft a checkpoint as if "gmail" was rotated before the
    // crash and "linear" is still pending.
    const globalKey = deriveGlobalEncryptionKey(newKey);
    const checkpoint: AdapterRotationCheckpoint = {
      v: ADAPTER_ROTATION_CHECKPOINT_V,
      started_at: new Date().toISOString(),
      old_key_enc: encrypt(oldKey.toString("base64"), globalKey),
      pending: ["linear"],
      completed: [{ adapter: "gmail", status: "rotated" }],
      failed: [],
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const result = resumeAdapterRotationIfPending({
      userDir,
      currentMasterKey: newKey,
      resolveModulePath: (a) => path.join(tmpDir, `usrcp-${a}`, "dist", "config.js"),
    });

    expect(result).not.toBeNull();
    // Returns the FULL tally (pre-crash + post-crash), not just the resume's work.
    expect(result!.rotated.sort()).toEqual(["gmail", "linear"]);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("resumeAdapterRotationIfPending returns null when no checkpoint exists", () => {
    const { userDir } = setupUserDir();
    expect(
      resumeAdapterRotationIfPending({ userDir, currentMasterKey: newKey })
    ).toBeNull();
  });

  it("resumeAdapterRotationIfPending returns null when the checkpoint cannot be decrypted (orphan)", () => {
    const { userDir, checkpointPath } = setupUserDir();
    // Write a checkpoint sealed under a DIFFERENT key. This is the
    // "two rotations in succession, second was killed" pattern - the
    // checkpoint's old_key_enc was sealed under newKey_v1, but the
    // current master is newKey_v2. We refuse to make wrong-key
    // decryption attempts; the orphan file is left in place for
    // operator inspection.
    const wrongGlobal = deriveGlobalEncryptionKey(Buffer.alloc(32, 0x33));
    const checkpoint: AdapterRotationCheckpoint = {
      v: ADAPTER_ROTATION_CHECKPOINT_V,
      started_at: new Date().toISOString(),
      old_key_enc: encrypt(oldKey.toString("base64"), wrongGlobal),
      pending: ["gmail"],
      completed: [],
      failed: [],
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resumeAdapterRotationIfPending({
      userDir,
      currentMasterKey: newKey,
    });
    expect(result).toBeNull();
    expect(fs.existsSync(checkpointPath)).toBe(true);
    warnSpy.mockRestore();
  });

  it("resumeAdapterRotationIfPending ignores a malformed checkpoint without erasing it", () => {
    const { userDir, checkpointPath } = setupUserDir();
    fs.writeFileSync(checkpointPath, "not-json{{");
    const result = resumeAdapterRotationIfPending({
      userDir,
      currentMasterKey: newKey,
    });
    expect(result).toBeNull();
    expect(fs.existsSync(checkpointPath)).toBe(true);
  });
});

describe("ADAPTERS_WITH_ENCRYPTED_CONFIG (legacy snapshot)", () => {
  it("preserves the historical static snapshot for back-compat", () => {
    // After the marketplace registry refactor (PR #62), this is
    // derived from BUILTIN_ADAPTERS.supportsRotateKey rather than
    // hardcoded. The snapshot is still asserted explicitly here so
    // a regression that quietly removes an adapter's supportsRotateKey
    // flag fails this test loudly.
    expect(new Set(ADAPTERS_WITH_ENCRYPTED_CONFIG)).toEqual(
      new Set(["google-calendar", "gmail", "linear", "discord", "slack", "telegram", "github"]),
    );
  });

  it("snapshot is stable across machines: does NOT read external adapters.json at import time (codex PR #62 round-3)", async () => {
    // The first cut of the registry refactor read the external
    // registry at module-import time, so a developer with
    // ~/.usrcp/adapters.json containing a rotate-key adapter got a
    // larger "static" snapshot than CI. Codex round-3 caught it.
    //
    // The contract: ADAPTERS_WITH_ENCRYPTED_CONFIG is a freeze of
    // the IN-TREE adapter set, not the merged registry. Use a
    // fresh import after writing an external rotate-key adapter to
    // disk and assert the snapshot is unchanged.
    const { BUILTIN_ADAPTERS, getRotateKeyAdapterValues } = await import(
      "../adapters/registry.js"
    );

    // 1. Direct equivalence with BUILTIN_ADAPTERS source-of-truth.
    const builtinOnly = getRotateKeyAdapterValues([...BUILTIN_ADAPTERS]);
    expect(new Set(ADAPTERS_WITH_ENCRYPTED_CONFIG)).toEqual(new Set(builtinOnly));

    // 2. Stronger guarantee: register an external rotate-key
    //    adapter, force a fresh module import, and assert the
    //    re-imported snapshot is STILL the in-tree set. (Pre-fix
    //    this test would have included "extra" in the snapshot.)
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-snapshot-test-"));
    const origHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      fs.mkdirSync(path.join(tmpHome, ".usrcp"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpHome, ".usrcp", "adapters.json"),
        JSON.stringify(
          {
            adapters: [
              {
                value: "extra-rotator",
                name: "Extra",
                blurb: "External adapter that would change the snapshot pre-fix.",
                setupFunction: "runExtraSetup",
                supportsRotateKey: true,
              },
            ],
          },
          null,
          2,
        ),
      );
      vi.resetModules();
      const fresh = await import("../rotate-adapter-configs.js");
      expect(new Set(fresh.ADAPTERS_WITH_ENCRYPTED_CONFIG)).toEqual(
        new Set(["google-calendar", "gmail", "linear", "discord", "slack", "telegram", "github"]),
      );
      // Dynamic getter DOES include the external entry (sanity that
      // the registry merge logic isn't completely broken).
      expect(fresh.getAdaptersWithEncryptedConfig()).toContain("extra-rotator");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
