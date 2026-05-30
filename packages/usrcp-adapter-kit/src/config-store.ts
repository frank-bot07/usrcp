import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  encrypt,
  decrypt,
  deriveGlobalEncryptionKey,
  zeroBuffer,
} from "usrcp-local/encryption";

/**
 * Shared, encrypted-at-rest config store for USRCP capture adapters.
 *
 * Before this module existed, every capture adapter (linear, github,
 * gmail, google-calendar, slack, telegram, discord, imessage) shipped a
 * near-identical ~250-line `config.ts`: the same AES-GCM secret
 * encrypt/decrypt wrappers, the same atomic 0600 writer, the same
 * "validate-or-process.exit(1)" gate, the same legacy-plaintext
 * auto-migration, the same `reencryptConfigUnderNewKey` rotation helper,
 * and the same debounced cursor persistence. That duplication was a
 * correctness liability, not just tidiness: the rotation/re-encrypt path
 * is security-sensitive, so a fix to one copy (e.g. the v0.1.5 rotation
 * hardening) had to be hand-propagated to eight files.
 *
 * `createAdapterConfig` lifts all of it into one tested place,
 * parameterized by a declarative field spec. Each adapter's `config.ts`
 * shrinks to: declare its `TConfig` interface, list its fields, and
 * re-export the store's methods under its existing public names so
 * consumer modules (setup.ts, capture.ts, index.ts) don't change.
 */

/**
 * How a config field is validated and handled at rest.
 *
 *   secret                 required (truthy) AND encrypted at rest under
 *                          the USRCP global key
 *   required               required (truthy)
 *   requiredNumber         required, must be `typeof === "number"`
 *   requiredNonEmptyArray  required, must be a non-empty array
 *   optional               not validated (cursors, optional allowlists)
 */
export type FieldKind =
  | "secret"
  | "required"
  | "requiredNumber"
  | "requiredNonEmptyArray"
  | "optional";

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  /**
   * Default applied during loadConfig / cursor-flush assembly when the
   * field is absent on disk (e.g. github `allowlisted_orgs` -> []).
   * Only meaningful for `optional` fields.
   */
  default?: unknown;
}

export interface AdapterConfigSpec {
  /** Short adapter slug, e.g. "linear". Used in error messages and the
   *  `usrcp setup --adapter=<name>` hint. */
  adapterName: string;
  /** Config filename under ~/.usrcp, e.g. "linear-config.json". */
  filename: string;
  /**
   * Ordered field list. Order matters: it drives the order fields appear
   * in the "incomplete config (missing: …)" message, matching the
   * hand-written per-adapter validators it replaces.
   */
  fields: FieldSpec[];
  /**
   * Field names that act as debounced cursors written via
   * saveCursors/flushCursors. Must be a subset of `fields` (declared
   * `optional`). Adapters with no poll cursor (bots) pass [].
   */
  cursorFields?: string[];
  /**
   * Re-encrypt a legacy plaintext secret back to disk the first time
   * loadConfig sees it. Default true (matches 7 of 8 adapters). imessage
   * sets false — it historically passes plaintext through on load and
   * lets the next explicit write encrypt it.
   */
  migrateLegacyOnLoad?: boolean;
}

export interface AdapterConfigStore<TConfig extends object> {
  getConfigPath(): string;
  /** Raw on-disk config (secrets still `enc:`-enveloped). {} if absent/unparsable. */
  readPartialConfig(): Partial<TConfig>;
  /** Like readPartialConfig but decrypts secret fields (best-effort). */
  readPartialDecryptedConfig(masterKey: Buffer): Partial<TConfig>;
  /** Encrypt secret fields and atomically write the config (mode 0600). */
  writeConfig(cfg: TConfig, masterKey: Buffer): void;
  /** Atomically write an object verbatim (no encryption). For bespoke
   *  cursor writers that preserve the existing `enc:` envelope. */
  writeRaw(obj: Record<string, unknown>): void;
  /** Validate on disk without the master key; process.exit(1) if invalid. */
  preflightConfig(): void;
  /** Validate + decrypt; process.exit(1) if invalid/undecryptable. */
  loadConfig(masterKey: Buffer): TConfig;
  /** Re-encrypt secrets under a new master key (atomic tmp+rename). */
  reencryptConfigUnderNewKey(
    oldKey: Buffer,
    newKey: Buffer,
  ): "absent" | "rotated";
  /** Stage cursor advances; debounced 500ms write that re-encrypts secrets. */
  saveCursors(cursors: Partial<TConfig>, masterKey: Buffer): void;
  /** Immediately flush any pending cursor write. */
  flushCursors(): void;
  /** Field names of the missing/invalid required fields in `partial`,
   *  in declared order. Empty array = complete. Exposed for adapters
   *  with a bespoke cursor flush that needs the same bail-guard. */
  missingRequiredFields(partial: Partial<TConfig>): string[];
}

function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return encrypt(plaintext, key);
  } finally {
    zeroBuffer(key);
  }
}

function maybeDecryptSecret(value: string, masterKey: Buffer): string {
  if (!value.startsWith("enc:")) return value;
  const key = deriveGlobalEncryptionKey(masterKey);
  try {
    return decrypt(value, key);
  } finally {
    zeroBuffer(key);
  }
}

export function createAdapterConfig<TConfig extends object>(
  spec: AdapterConfigSpec,
): AdapterConfigStore<TConfig> {
  const { adapterName, filename } = spec;
  const secretFields = spec.fields
    .filter((f) => f.kind === "secret")
    .map((f) => f.name);
  const cursorFields = spec.cursorFields ?? [];
  const defaults = spec.fields.filter((f) => f.default !== undefined);
  const migrateLegacyOnLoad = spec.migrateLegacyOnLoad ?? true;
  const setupHint = `Run 'usrcp setup --adapter=${adapterName}' to`;

  function getConfigPath(): string {
    return path.join(os.homedir(), ".usrcp", filename);
  }

  function readPartialConfig(): Partial<TConfig> {
    try {
      return JSON.parse(
        fs.readFileSync(getConfigPath(), "utf8"),
      ) as Partial<TConfig>;
    } catch {
      return {};
    }
  }

  function readPartialDecryptedConfig(masterKey: Buffer): Partial<TConfig> {
    const partial = readPartialConfig();
    const out: Partial<TConfig> = { ...partial };
    try {
      for (const f of secretFields) {
        const v = (partial as Record<string, unknown>)[f];
        if (typeof v === "string") {
          (out as Record<string, unknown>)[f] = maybeDecryptSecret(v, masterKey);
        }
      }
    } catch {
      /* Best effort: wizard validation will catch decrypt failures. */
    }
    return out;
  }

  function writeRaw(obj: Record<string, unknown>): void {
    const p = getConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const body = JSON.stringify(obj, null, 2);
    const fd = fs.openSync(
      p,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
      0o600,
    );
    try {
      fs.writeSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
    // O_CREAT mode is a no-op if the file already existed.
    fs.chmodSync(p, 0o600);
  }

  function writeConfig(cfg: TConfig, masterKey: Buffer): void {
    const onDisk: Record<string, unknown> = { ...(cfg as Record<string, unknown>) };
    for (const f of secretFields) {
      const v = (cfg as Record<string, unknown>)[f];
      if (typeof v === "string") {
        onDisk[f] = encryptSecret(v, masterKey);
      }
    }
    writeRaw(onDisk);
  }

  function missingRequiredFields(partial: Partial<TConfig>): string[] {
    const missing: string[] = [];
    const p = partial as Record<string, unknown>;
    for (const f of spec.fields) {
      switch (f.kind) {
        case "secret":
        case "required":
          if (!p[f.name]) missing.push(f.name);
          break;
        case "requiredNumber":
          if (typeof p[f.name] !== "number") missing.push(f.name);
          break;
        case "requiredNonEmptyArray": {
          const v = p[f.name];
          if (!Array.isArray(v) || v.length === 0) missing.push(f.name);
          break;
        }
        case "optional":
          break;
      }
    }
    return missing;
  }

  function readValidatedPartial(): Partial<TConfig> {
    const p = getConfigPath();
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      console.error(
        `usrcp-${adapterName}: no config found at ${p}.\n` +
          `${setupHint} configure.`,
      );
      process.exit(1);
    }
    let partial: Partial<TConfig>;
    try {
      partial = JSON.parse(raw) as Partial<TConfig>;
    } catch {
      console.error(
        `usrcp-${adapterName}: failed to parse config at ${p}.\n` +
          `${setupHint} re-configure.`,
      );
      process.exit(1);
    }
    const missing = missingRequiredFields(partial);
    if (missing.length > 0) {
      console.error(
        `usrcp-${adapterName}: incomplete config (missing: ${missing.join(", ")}).\n` +
          `${setupHint} re-configure.`,
      );
      process.exit(1);
    }
    return partial;
  }

  function preflightConfig(): void {
    readValidatedPartial();
  }

  /** Assemble a decrypted, defaults-applied config from a validated partial. */
  function assembleDecrypted(
    partial: Partial<TConfig>,
    masterKey: Buffer,
  ): TConfig {
    const out: Record<string, unknown> = { ...partial };
    for (const f of defaults) {
      if (out[f.name] === undefined) out[f.name] = f.default;
    }
    for (const f of secretFields) {
      const v = (partial as Record<string, unknown>)[f];
      if (typeof v === "string") out[f] = maybeDecryptSecret(v, masterKey);
    }
    return out as TConfig;
  }

  function loadConfig(masterKey: Buffer): TConfig {
    const partial = readValidatedPartial();
    let decrypted: TConfig;
    try {
      decrypted = assembleDecrypted(partial, masterKey);
    } catch (err) {
      const label = secretFields.length > 1 ? "config secrets" : "config secret";
      console.error(
        `usrcp-${adapterName}: failed to decrypt ${label} (wrong passphrase or corrupt file): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(1);
    }
    // Auto-migrate legacy plaintext configs at load time so an idle
    // adapter doesn't leave a secret plaintext on disk indefinitely after
    // the encryption rollout.
    if (migrateLegacyOnLoad) {
      const wasLegacyPlaintext = secretFields.some((f) => {
        const v = (partial as Record<string, unknown>)[f];
        return typeof v === "string" && !v.startsWith("enc:");
      });
      if (wasLegacyPlaintext) {
        try {
          writeConfig(decrypted, masterKey);
        } catch {
          /* Non-fatal; next save will retry. */
        }
      }
    }
    return decrypted;
  }

  function reencryptConfigUnderNewKey(
    oldKey: Buffer,
    newKey: Buffer,
  ): "absent" | "rotated" {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return "absent";

    const raw = fs.readFileSync(p, "utf8");
    const partial = JSON.parse(raw) as Record<string, unknown>;
    for (const f of secretFields) {
      if (!partial[f]) {
        throw new Error(
          `incomplete ${adapterName} config at ${p}; cannot re-encrypt`,
        );
      }
    }

    const oldGlobal = deriveGlobalEncryptionKey(oldKey);
    const newGlobal = deriveGlobalEncryptionKey(newKey);
    try {
      const passthrough = (v: string) =>
        v.startsWith("enc:") ? decrypt(v, oldGlobal) : v;
      const onDisk: Record<string, unknown> = { ...partial };
      for (const f of secretFields) {
        onDisk[f] = encrypt(passthrough(partial[f] as string), newGlobal);
      }
      const body = JSON.stringify(onDisk, null, 2);
      const tmp = `${p}.rotate-tmp.${process.pid}.${Date.now()}`;
      const fd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
        0o600,
      );
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, p);
      return "rotated";
    } finally {
      zeroBuffer(oldGlobal);
      zeroBuffer(newGlobal);
    }
  }

  // --- Debounced cursor persistence -------------------------------------
  // Closure-scoped per store instance — equivalent to the module-level
  // _pendingCursors / _flushTimer each adapter used to declare. Each
  // adapter calls createAdapterConfig once at module load, so it gets its
  // own pending state.
  let _pendingCursors: Partial<TConfig> = {};
  let _pendingMasterKey: Buffer | undefined;
  let _flushTimer: ReturnType<typeof setTimeout> | undefined;

  function saveCursors(cursors: Partial<TConfig>, masterKey: Buffer): void {
    for (const k of cursorFields) {
      const v = (cursors as Record<string, unknown>)[k];
      if (v !== undefined) (_pendingCursors as Record<string, unknown>)[k] = v;
    }
    _pendingMasterKey = masterKey;
    if (_flushTimer !== undefined) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = undefined;
      flushCursors();
    }, 500);
  }

  function flushCursors(): void {
    const pending = _pendingCursors;
    const masterKey = _pendingMasterKey;
    // Reset before writing so a failed write doesn't leave stale pending
    // state across the next save call.
    _pendingCursors = {};
    _pendingMasterKey = undefined;
    if (!masterKey || Object.keys(pending).length === 0) return;

    const existing = readPartialConfig();
    // Bail if the on-disk config is gone or stripped — better to lose a
    // cursor than overwrite a missing secret with empty strings.
    if (missingRequiredFields(existing).length > 0) return;
    try {
      const decrypted = assembleDecrypted(existing, masterKey);
      writeConfig({ ...decrypted, ...pending }, masterKey);
    } catch {
      // Non-fatal — next restart may re-process a few events.
    }
  }

  return {
    getConfigPath,
    readPartialConfig,
    readPartialDecryptedConfig,
    writeConfig,
    writeRaw,
    preflightConfig,
    loadConfig,
    reencryptConfigUnderNewKey,
    saveCursors,
    flushCursors,
    missingRequiredFields,
  };
}
