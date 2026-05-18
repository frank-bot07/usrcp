/**
 * Adapter-config re-encryption hook for `usrcp_rotate_key`.
 *
 * Each adapter whose setup wizard encrypts secrets at rest exports
 * `reencryptConfigUnderNewKey(oldKey, newKey)` from its config module.
 * The Ledger's `rotateKey` invokes this dispatcher right after
 * committing the new master key to disk; without it, every adapter
 * would fail to decrypt its config on the next boot (the AES-GCM
 * envelope is derived from the *master* key via HKDF, and the master
 * key just changed).
 *
 * Per-adapter helpers are sync, atomic per-file (tmp + rename).
 * This dispatcher is sync too so the caller doesn't have to make
 * rotateKey async.
 *
 * The list of participating adapters is derived from the central
 * registry: any AdapterManifest with `supportsRotateKey: true` shows
 * up here. (The previous hardcoded `ADAPTERS_WITH_ENCRYPTED_CONFIG`
 * array had to be hand-synced with the master-key gate in setup.ts -
 * the manifest-derived approach eliminates that drift class.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AdapterManifest,
  getRegisteredAdapters,
  getRotateKeyAdapterValues,
  resolveAdapterPackageName,
} from "./adapters/registry.js";

/**
 * Convenience accessor for the rotate-key participation set. Derived
 * from manifest.supportsRotateKey - see registry.ts. Kept exported
 * under the old name so callers that imported it pre-marketplace
 * still resolve.
 */
export function getAdaptersWithEncryptedConfig(): string[] {
  return getRotateKeyAdapterValues();
}

/**
 * @deprecated since the marketplace registry landed - re-derive via
 * getAdaptersWithEncryptedConfig() (or call getRotateKeyAdapterValues
 * directly) so external adapters in `~/.usrcp/adapters.json` are
 * included. The static export is kept for backward compatibility only.
 */
export const ADAPTERS_WITH_ENCRYPTED_CONFIG: ReadonlyArray<string> = Object.freeze(
  getRotateKeyAdapterValues(),
);

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
 * config module path. The default resolver checks the monorepo
 * layout first (packages/<pkg>/dist/config.js) and falls back to
 * `require.resolve(<pkg>/dist/config.js)` so external adapters
 * registered via `~/.usrcp/adapters.json` resolve cleanly.
 */
export type AdapterModuleResolver = (adapter: string) => string;

function lookupManifest(adapter: string, manifests: AdapterManifest[]): AdapterManifest | undefined {
  return manifests.find((m) => m.value === adapter);
}

const defaultResolver: AdapterModuleResolver = (adapter) => {
  const manifests = getRegisteredAdapters();
  const manifest = lookupManifest(adapter, manifests);
  // Builtin-internal adapters don't live in a sibling package, so
  // they should never reach this resolver (their reencrypt helpers
  // don't exist). The dispatcher filters them out via
  // getRotateKeyAdapterValues, but we defend here too.
  if (manifest && manifest.builtinInternal) {
    return ""; // signals "skip" to the caller's existsSync check
  }
  const pkg = manifest ? resolveAdapterPackageName(manifest) : `usrcp-${adapter}`;
  if (!pkg) return "";
  // __dirname when compiled lives in packages/usrcp-local/dist/.
  // Two levels up gets us to packages/. We check the monorepo path
  // first (in-tree adapters); the caller's existsSync gate falls
  // through to the npm-resolved path via the per-call helper below.
  const localPkgDir = path.resolve(__dirname, "..");
  const monoRoot = path.resolve(localPkgDir, "..");
  const monoPath = path.join(monoRoot, pkg, "dist", "config.js");
  if (fs.existsSync(monoPath)) return monoPath;
  // External adapter: resolve through npm.
  try {
    return require.resolve(`${pkg}/dist/config.js`);
  } catch {
    return "";
  }
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
  // Re-derive the list per call so external adapters added at
  // runtime via `~/.usrcp/adapters.json` participate in rotation
  // without restarting the daemon.
  const adapters = opts.adapters ?? getRotateKeyAdapterValues();

  const rotated: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ adapter: string; reason: string }> = [];

  for (const adapter of adapters) {
    const modulePath = resolver(adapter);
    if (!modulePath || !fs.existsSync(modulePath)) {
      // Adapter package not installed in this checkout. That's
      // fine - skip, don't fail rotation. The defaultResolver
      // returns "" for unresolvable packages (e.g. external adapter
      // registered but its npm package isn't installed yet).
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
