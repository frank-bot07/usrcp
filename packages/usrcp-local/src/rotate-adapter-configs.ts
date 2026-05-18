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
  decrypt,
  deriveGlobalEncryptionKey,
  encrypt,
  safeWriteFile,
  zeroBuffer,
} from "./encryption.js";
import {
  type AdapterManifest,
  BUILTIN_ADAPTERS,
  getRegisteredAdapters,
  getRotateKeyAdapterValues,
  resolveAdapterPackageName,
} from "./adapters/registry.js";

/**
 * Convenience accessor for the rotate-key participation set. Derived
 * from manifest.supportsRotateKey - see registry.ts. Kept exported
 * under the old name so callers that imported it pre-marketplace
 * still resolve. Reads through `~/.usrcp/adapters.json` per call so
 * external adapters participate at rotation time.
 */
export function getAdaptersWithEncryptedConfig(): string[] {
  return getRotateKeyAdapterValues();
}

/**
 * @deprecated since the marketplace registry landed (PR #62) - re-derive
 * via getAdaptersWithEncryptedConfig() so external adapters in
 * `~/.usrcp/adapters.json` are included. Kept here as a stable
 * snapshot of the in-tree adapters at the time of the refactor, for
 * backward compatibility with any pre-#62 consumer that imported the
 * constant expecting a fixed set.
 *
 * IMPORTANT: this snapshot is derived from BUILTIN_ADAPTERS, not from
 * the live registry. Codex round-3 review on PR #62 caught the first
 * cut reading the external file at import time - that made the
 * snapshot non-deterministic across machines AND introduced unwanted
 * disk I/O at module load for any consumer that imports this module.
 * The snapshot belongs to the in-tree contract; external adapters use
 * the dynamic getter above.
 */
export const ADAPTERS_WITH_ENCRYPTED_CONFIG: ReadonlyArray<string> = Object.freeze(
  getRotateKeyAdapterValues([...BUILTIN_ADAPTERS]),
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
 * Persistent breadcrumb written between commitKeyRotation() and the
 * per-adapter loop. If the process dies mid-loop, the next Ledger
 * boot reads this file, decrypts the stashed old key with the new
 * (current) master key, and resumes the per-adapter rotation for
 * adapters still in `pending`. After the loop completes (success,
 * skip, or fail-but-recorded), the file is removed.
 *
 * `old_key_enc` uses the standard `"enc:"` AES-GCM envelope keyed
 * off `deriveGlobalEncryptionKey(NEW_MASTER_KEY)`. The new master
 * key is durably on disk by the time this file is written, so the
 * recovery path can always derive it.
 */
export const ADAPTER_ROTATION_CHECKPOINT_V = 1;

export interface AdapterRotationCheckpoint {
  v: typeof ADAPTER_ROTATION_CHECKPOINT_V;
  started_at: string;
  old_key_enc: string;
  pending: string[];
  completed: Array<{ adapter: string; status: "rotated" | "absent" }>;
  failed: Array<{ adapter: string; reason: string }>;
}

function checkpointPathFor(userDir: string): string {
  return path.join(userDir, "keys", "adapter-rotation.json");
}

function writeCheckpoint(p: string, cp: AdapterRotationCheckpoint): void {
  safeWriteFile(p, Buffer.from(JSON.stringify(cp), "utf-8"), 0o600);
}

function readCheckpoint(p: string): AdapterRotationCheckpoint | null {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (raw?.v !== ADAPTER_ROTATION_CHECKPOINT_V) return null;
    if (typeof raw.old_key_enc !== "string") return null;
    if (!Array.isArray(raw.pending)) return null;
    return raw as AdapterRotationCheckpoint;
  } catch {
    return null;
  }
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
  /**
   * When set, the dispatcher persists a per-adapter checkpoint at
   * `<userDir>/keys/adapter-rotation.json` (write before the loop;
   * update after each adapter; delete after the loop). Callers from
   * `Ledger.rotateKey`'s onKeysReady hook should pass `userDir` so a
   * SIGKILL mid-loop becomes resumable on next Ledger boot.
   */
  userDir?: string;
  /**
   * Internal: when resuming via `resumeAdapterRotationIfPending`, the
   * pre-existing checkpoint is reused (and `adapters` is the residual
   * `pending` list). The checkpoint's `completed` / `failed` arrays
   * are preserved across the resume.
   */
  resumeFromCheckpoint?: AdapterRotationCheckpoint;
}): AdapterReencryptResult {
  const resolver = opts.resolveModulePath ?? defaultResolver;
  // Re-derive the list per call so external adapters added at
  // runtime via `~/.usrcp/adapters.json` participate in rotation
  // without restarting the daemon.
  const adapters = opts.adapters ?? getRotateKeyAdapterValues();

  // Seed the result accumulators from a resumed checkpoint so the
  // returned tally reflects the FULL rotation (pre-crash + post-crash),
  // not just this turn's work.
  const rotated: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ adapter: string; reason: string }> = [];
  if (opts.resumeFromCheckpoint) {
    for (const entry of opts.resumeFromCheckpoint.completed) {
      if (entry.status === "rotated") rotated.push(entry.adapter);
      else if (entry.status === "absent") absent.push(entry.adapter);
    }
    failed.push(...opts.resumeFromCheckpoint.failed);
  }

  const checkpointPath = opts.userDir ? checkpointPathFor(opts.userDir) : null;
  let checkpoint: AdapterRotationCheckpoint | null = null;
  if (checkpointPath) {
    checkpoint = opts.resumeFromCheckpoint
      ? { ...opts.resumeFromCheckpoint, pending: [...adapters] }
      : {
          v: ADAPTER_ROTATION_CHECKPOINT_V,
          started_at: new Date().toISOString(),
          old_key_enc: encrypt(
            opts.oldKey.toString("base64"),
            deriveGlobalEncryptionKey(opts.newKey)
          ),
          pending: [...adapters],
          completed: [],
          failed: [],
        };
    writeCheckpoint(checkpointPath, checkpoint);
  }

  const recordCompletion = (
    adapter: string,
    status: "rotated" | "absent"
  ): void => {
    if (status === "rotated") rotated.push(adapter);
    else absent.push(adapter);
    if (checkpoint) {
      checkpoint.pending = checkpoint.pending.filter((a) => a !== adapter);
      checkpoint.completed.push({ adapter, status });
      writeCheckpoint(checkpointPath!, checkpoint);
    }
  };

  const recordFailure = (adapter: string, reason: string): void => {
    failed.push({ adapter, reason });
    if (checkpoint) {
      checkpoint.pending = checkpoint.pending.filter((a) => a !== adapter);
      checkpoint.failed.push({ adapter, reason });
      writeCheckpoint(checkpointPath!, checkpoint);
    }
  };

  for (const adapter of adapters) {
    const modulePath = resolver(adapter);
    if (!modulePath || !fs.existsSync(modulePath)) {
      // Adapter package not installed in this checkout. That's
      // fine - skip, don't fail rotation. The defaultResolver
      // returns "" for unresolvable packages (e.g. external adapter
      // registered but its npm package isn't installed yet). Drop
      // it from `pending` so a future resume doesn't re-try it under
      // a still-uninstalled state.
      if (checkpoint) {
        checkpoint.pending = checkpoint.pending.filter((a) => a !== adapter);
        writeCheckpoint(checkpointPath!, checkpoint);
      }
      continue;
    }
    let mod: ReencryptableModule;
    try {
      mod = require(modulePath) as ReencryptableModule;
    } catch (err) {
      recordFailure(
        adapter,
        `failed to load ${modulePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const fn = mod.reencryptConfigUnderNewKey;
    if (typeof fn !== "function") {
      recordFailure(adapter, `${modulePath} does not export reencryptConfigUnderNewKey`);
      continue;
    }
    try {
      const result = fn(opts.oldKey, opts.newKey);
      if (result === "rotated") recordCompletion(adapter, "rotated");
      else if (result === "absent") recordCompletion(adapter, "absent");
    } catch (err) {
      recordFailure(adapter, err instanceof Error ? err.message : String(err));
    }
  }

  if (checkpointPath) {
    try { fs.unlinkSync(checkpointPath); } catch { /* tolerate already-gone */ }
  }

  return { rotated, absent, failed };
}

/**
 * Recovery path. If a previous rotateKey was SIGKILLed between
 * commitKeyRotation() and the end of reencryptAdapterConfigs, the
 * checkpoint file at `<userDir>/keys/adapter-rotation.json` will
 * persist. This function reads it, decrypts the stashed old key
 * with the current master key (which is the post-rotation key on
 * disk and matches the `new_key` the checkpoint was sealed under),
 * and resumes the per-adapter loop for whatever adapters are still
 * in `pending`. Returns null when no checkpoint exists. On success,
 * the checkpoint file is removed.
 *
 * Idempotent: if the checkpoint is malformed or unreadable, returns
 * null (no recovery attempted; caller may inspect manually).
 */
export function resumeAdapterRotationIfPending(opts: {
  userDir: string;
  currentMasterKey: Buffer;
  resolveModulePath?: AdapterModuleResolver;
}): AdapterReencryptResult | null {
  const checkpointPath = checkpointPathFor(opts.userDir);
  const checkpoint = readCheckpoint(checkpointPath);
  if (!checkpoint) return null;

  const newGlobalKey = deriveGlobalEncryptionKey(opts.currentMasterKey);
  let oldKey: Buffer;
  try {
    const b64 = decrypt(checkpoint.old_key_enc, newGlobalKey);
    oldKey = Buffer.from(b64, "base64");
  } catch (err) {
    // Cannot recover: the checkpoint's old_key was sealed under a
    // different key than the current one (perhaps multiple rotations
    // happened in succession and the checkpoint was orphaned). Leave
    // the file in place for manual inspection rather than blowing it
    // away. Caller decides what to do.
    console.warn(
      `[usrcp] resumeAdapterRotationIfPending: cannot decrypt checkpoint at ${checkpointPath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    zeroBuffer(newGlobalKey);
    return null;
  }
  zeroBuffer(newGlobalKey);

  try {
    return reencryptAdapterConfigs({
      oldKey,
      newKey: opts.currentMasterKey,
      adapters: [...checkpoint.pending],
      resolveModulePath: opts.resolveModulePath,
      userDir: opts.userDir,
      resumeFromCheckpoint: checkpoint,
    });
  } finally {
    zeroBuffer(oldKey);
  }
}
