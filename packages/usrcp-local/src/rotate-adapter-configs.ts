/**
 * Adapter-config re-encryption hook for `usrcp_rotate_key`.
 *
 * Each adapter package whose setup wizard encrypts secrets at rest
 * exports `reencryptConfigUnderNewKey(oldKey, newKey)`. The Ledger's
 * `rotateKey` invokes this dispatcher right after committing the
 * new master key to disk; without it, every adapter would fail to
 * decrypt its config on the next boot (the AES-GCM envelope is
 * derived from the *master* key via HKDF, and the master key just
 * changed).
 *
 * Per-adapter helpers are sync, atomic per-file (tmp + rename).
 * This dispatcher is sync too so the caller doesn't have to make
 * rotateKey async.
 *
 * Adapter packages are loaded via `createRequire` from their
 * compiled `dist/config.js`, matching the dispatch pattern in
 * `setup.ts`. Adapters NOT in `ADAPTERS_WITH_ENCRYPTED_CONFIG` are
 * skipped silently - terminal/imessage/obsidian have no secrets
 * encrypted under the master key today.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Adapters that expose a `reencryptConfigUnderNewKey` export.
 * Must match the set in `setup.ts:ADAPTERS_REQUIRING_MASTER_KEY` -
 * an adapter whose wizard encrypts secrets at rest also needs its
 * configs re-encrypted on rotate.
 */
export const ADAPTERS_WITH_ENCRYPTED_CONFIG: ReadonlyArray<string> = [
  "google-calendar",
  "gmail",
  "linear",
  "discord",
  "slack",
  "telegram",
  "github",
];

export interface AdapterReencryptResult {
  /** Adapters whose on-disk config was successfully re-encrypted. */
  rotated: string[];
  /** Adapters with no config file on disk (nothing to do). */
  absent: string[];
  /** Adapters that failed; user should re-run `usrcp setup --adapter=<name>`. */
  failed: Array<{ adapter: string; reason: string }>;
}

/**
 * For tests / non-monorepo deployments: resolve an adapter package's
 * config module path. Defaults to the monorepo layout
 * (`packages/usrcp-<name>/dist/config.js`).
 */
export type AdapterModuleResolver = (adapter: string) => string;

const defaultResolver: AdapterModuleResolver = (adapter) => {
  // __dirname when compiled lives in packages/usrcp-local/dist/.
  // Two levels up gets us to packages/.
  const localPkgDir = path.resolve(__dirname, "..");
  const monoRoot = path.resolve(localPkgDir, "..");
  return path.join(monoRoot, `usrcp-${adapter}`, "dist", "config.js");
};

interface ReencryptableModule {
  reencryptConfigUnderNewKey?: (oldKey: Buffer, newKey: Buffer) => "absent" | "rotated";
}

export function reencryptAdapterConfigs(opts: {
  oldKey: Buffer;
  newKey: Buffer;
  /** Override the module-path resolver (tests). */
  resolveModulePath?: AdapterModuleResolver;
  /** Override the adapter list (tests). */
  adapters?: ReadonlyArray<string>;
}): AdapterReencryptResult {
  const resolver = opts.resolveModulePath ?? defaultResolver;
  const adapters = opts.adapters ?? ADAPTERS_WITH_ENCRYPTED_CONFIG;

  const rotated: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ adapter: string; reason: string }> = [];

  for (const adapter of adapters) {
    const modulePath = resolver(adapter);
    if (!fs.existsSync(modulePath)) {
      // Adapter package not installed in this checkout. That's
      // fine - skip, don't fail rotation.
      continue;
    }
    let mod: ReencryptableModule;
    try {
      mod = require(modulePath) as ReencryptableModule;
    } catch (err) {
      failed.push({
        adapter,
        reason: `failed to load ${modulePath}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const fn = mod.reencryptConfigUnderNewKey;
    if (typeof fn !== "function") {
      failed.push({
        adapter,
        reason: `${modulePath} does not export reencryptConfigUnderNewKey`,
      });
      continue;
    }
    try {
      const result = fn(opts.oldKey, opts.newKey);
      if (result === "rotated") rotated.push(adapter);
      else if (result === "absent") absent.push(adapter);
    } catch (err) {
      failed.push({
        adapter,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { rotated, absent, failed };
}
