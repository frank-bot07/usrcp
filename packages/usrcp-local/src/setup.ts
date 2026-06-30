/**
 * `usrcp setup` — unified interactive wizard.
 *
 * Configures the ledger (step 1) and one or more adapter(s) (steps 2+) in
 * a single linear flow. No directory-switching required.
 *
 * Usage:
 *   usrcp setup                        # full wizard
 *   usrcp setup --adapter=discord      # only (re-)configure the Discord adapter
 *   usrcp setup --adapter=telegram     # only (re-)configure the Telegram adapter
 *
 * Stop conditions respected from the handoff doc:
 *   - Resume from failure (setup-progress.json): SKIPPED in v0. If interrupted,
 *     run 'usrcp setup' again to retry.
 *   - @inquirer/prompts multi-select: works fine with 'checkbox'. The lib is ESM-only
 *     so we load it via dynamic import() from this CJS module.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  isPassphraseMode,
  initializeMasterKey,
  getUserDir,
  getUsrcpBaseDir,
  listUserSlugs,
  migrateLegacyLayout,
  setUserSlug,
} from "usrcp-core/encryption";
import { initializeIdentity } from "usrcp-core/crypto";
import { Ledger } from "usrcp-core/ledger";
import {
  type AdapterManifest,
  findAdapter,
  getExternalRegistryPath,
  getMasterKeyRequiringAdapterValues,
  getRegisteredAdapters,
  resolveAdapterPackageName,
} from "./adapters/registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** If set, skip adapter selection and only run this adapter's setup. */
  adapter?: string;
}

// @inquirer/prompts is ESM-only; load it via dynamic import at call time.
// We inline the minimal types we need to avoid the "resolution-mode" error
// that TypeScript 5.x emits for `typeof import(esm-pkg)` in CJS modules.

interface CheckboxChoice<T> { name: string; value: T; checked?: boolean; disabled?: boolean | string; }
interface SelectChoice<T> { name: string; value: T; }

interface Prompts {
  checkbox<T>(opts: { message: string; choices: CheckboxChoice<T>[]; validate?: (a: T[]) => boolean | string }): Promise<T[]>;
  select<T>(opts: { message: string; choices: SelectChoice<T>[] }): Promise<T>;
  input(opts: { message: string; default?: string }): Promise<string>;
  password(opts: { message: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

async function getPrompts(): Promise<Prompts> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import("@inquirer/prompts") as unknown as Promise<Prompts>;
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/**
 * Dynamically resolve and call a package's runXxxSetup() function.
 * Uses __dirname (CJS) to find the packages/ monorepo root at runtime.
 *
 * Special case: the `terminal` adapter lives inside usrcp-local rather than
 * as a separate `packages/usrcp-terminal/` package, so its setup module is
 * imported directly and given the wizard's prompts object.
 */
async function callAdapterSetup(adapterName: string, masterKey?: Buffer): Promise<void> {
  // Builtin-internal adapters (terminal / mcp-agent / openclaw) live
  // inside usrcp-local and predate the sibling-package convention.
  // The dispatcher special-cases them BEFORE consulting the registry
  // so they can pass the prompts object the standard setupFunction
  // signature doesn't accept.
  if (adapterName === "terminal") {
    const { runTerminalSetup } = await import("./adapters/terminal/index.js");
    const prompts = await getPrompts();
    await runTerminalSetup({ checkbox: prompts.checkbox, confirm: prompts.confirm });
    return;
  }
  if (adapterName === "mcp-agent") {
    const { runMcpAgentSetup } = await import("./adapters/mcp-agent/setup.js");
    const prompts = await getPrompts();
    await runMcpAgentSetup({ input: prompts.input, confirm: prompts.confirm });
    return;
  }
  if (adapterName === "openclaw") {
    const { runOpenclawSetup } = await import("./adapters/openclaw/setup.js");
    await runOpenclawSetup();
    return;
  }

  // Everything else routes through the manifest registry.
  const manifest = findAdapter(adapterName);
  if (!manifest) {
    throw new Error(
      `Unknown adapter '${adapterName}'. Known adapters: ${getRegisteredAdapters()
        .map((m) => m.value)
        .join(", ")}.`,
    );
  }
  if (!manifest.setupFunction) {
    throw new Error(
      `Adapter '${adapterName}' manifest is missing 'setupFunction'. ` +
        `Builtin-internal adapters bypass this dispatcher; external adapters must declare it.`,
    );
  }

  const packageName = resolveAdapterPackageName(manifest);
  if (!packageName) {
    // resolveAdapterPackageName returns null only for builtinInternal,
    // which the early returns above already handled. Defensive.
    throw new Error(
      `Adapter '${adapterName}' is marked builtinInternal but reached the package-resolution path.`,
    );
  }

  // Resolve dist/setup.js. The same two-strategy resolution as before:
  // (a) monorepo layout (packages/<pkg>/dist/setup.js) for in-tree
  //     adapters that haven't been published; (b) npm resolution for
  //     external adapters installed alongside usrcp-local.
  // __dirname in dist/ is packages/usrcp-local/dist/, so two levels
  // up is packages/.
  const localPkgDir = path.resolve(__dirname, "..");
  const monoRoot = path.resolve(localPkgDir, "..");
  const monoSetupPath = path.join(monoRoot, packageName, "dist", "setup.js");

  let setupPath: string;
  if (fs.existsSync(monoSetupPath)) {
    setupPath = monoSetupPath;
  } else {
    // Fall back to npm resolution. This is the path external adapters
    // take: they're npm-installed alongside usrcp-local, not in the
    // monorepo's packages/ directory.
    try {
      setupPath = require.resolve(`${packageName}/dist/setup.js`);
    } catch {
      throw new Error(
        `Cannot find setup module for adapter '${adapterName}'.\n` +
          `  Tried monorepo path: ${monoSetupPath}\n` +
          `  Tried npm resolution: ${packageName}/dist/setup.js\n` +
          `  For in-tree adapters: 'npm run build' inside packages/${packageName}/.\n` +
          `  For external adapters: 'npm install ${packageName}' and verify the manifest in ${getExternalRegistryPath()}.`,
      );
    }
  }

  // Dynamic import of the compiled JS (adapter packages are ESM-compatible).
  const mod = (await import(setupPath)) as Record<string, unknown>;
  const fn = mod[manifest.setupFunction] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof fn !== "function") {
    throw new Error(
      `Adapter module at ${setupPath} does not export '${manifest.setupFunction}' (declared in manifest).`,
    );
  }
  // Adapters that encrypt config secrets at rest accept `{ masterKey }`.
  // Older adapters that don't accept args silently ignore the extra
  // parameter - JS lets us pass it freely.
  await fn({ masterKey });
}

// ---------------------------------------------------------------------------
// Ledger step
// ---------------------------------------------------------------------------

async function ensureLedger(): Promise<{ masterKey: Buffer; passphrase: string | undefined }> {
  const migration = migrateLegacyLayout();
  if (migration.migrated) {
    console.error(`  Migrated legacy files into users/default/: ${migration.movedPaths.join(", ")}`);
  }

  const slugs = listUserSlugs();
  const usrcpDir = getUsrcpBaseDir();
  const { select, password, confirm } = await getPrompts();

  console.log("\nStep 1 — Ledger");
  console.log("───────────────");

  if (slugs.length === 0) {
    // Fresh install — initialize with passphrase
    console.log("  No ledger found. We'll create one now.");
    console.log(`  Data will live at ${usrcpDir}/users/default/`);
    console.log("");

    const usePp = await confirm({
      message: "Use passphrase protection? (recommended — encrypts your data at rest)",
      default: true,
    });

    let passphrase: string | undefined;
    if (usePp) {
      while (true) {
        const p1 = await password({ message: "  Passphrase:" });
        if (!p1) { console.log("  Passphrase cannot be empty."); continue; }
        const p2 = await password({ message: "  Confirm:   " });
        if (p1 !== p2) { console.log("  Passphrases do not match. Try again."); continue; }
        passphrase = p1;
        break;
      }
    }

    setUserSlug("default");
    const masterKey = initializeMasterKey(passphrase);
    const identity = initializeIdentity(masterKey);
    const ledger = new Ledger(undefined, passphrase);
    ledger.close();

    console.log(`  ✓ Ledger initialized (user: default, id: ${identity.user_id})`);
    console.log(`  ✓ Keys at ${getUserDir()}/keys/`);
    if (passphrase) {
      console.log("  ✓ Set USRCP_PASSPHRASE in your env when starting adapters:");
      console.log('    export USRCP_PASSPHRASE="<your passphrase>"');
    }
    return { masterKey, passphrase };
  } else if (slugs.length === 1) {
    setUserSlug(slugs[0]);
    const inPp = isPassphraseMode();
    console.log(`  Existing ledger detected: user "${slugs[0]}" at ${usrcpDir}/users/${slugs[0]}/`);
    if (inPp) {
      console.log("  ✓ Passphrase-protected. (Set USRCP_PASSPHRASE when starting adapters.)");
    } else {
      console.log("  ✓ Dev mode (key on disk).");
    }
    const choice = await select({
      message: "  What would you like to do?",
      choices: [
        { name: `Use existing "${slugs[0]}" ledger (recommended)`, value: "use" },
        { name: "Re-initialize (destructive — wipes the ledger)", value: "reset" },
      ],
    });
    if (choice === "reset") {
      const sure = await confirm({ message: "  Are you sure? This cannot be undone.", default: false });
      if (sure) {
        const ledgerPath = path.join(getUserDir(), "ledger.db");
        if (fs.existsSync(ledgerPath)) fs.rmSync(ledgerPath);
        const ledger = new Ledger(undefined, undefined);
        ledger.close();
        console.log("  ✓ Ledger reset.");
      } else {
        console.log("  Keeping existing ledger.");
      }
    } else {
      console.log(`  ✓ Using existing "${slugs[0]}" ledger.`);
    }
    return await resolveExistingMasterKey(inPp, password);
  } else {
    // Multiple users — require explicit selection
    const chosen = await select({
      message: "  Multiple users found. Which one should setup configure?",
      choices: slugs.map((s) => ({ name: s, value: s })),
    });
    setUserSlug(chosen);
    console.log(`  ✓ Using user "${chosen}".`);
    return await resolveExistingMasterKey(isPassphraseMode(), password);
  }
}

/**
 * Derive the master key for an existing ledger. Reads USRCP_PASSPHRASE
 * first; if missing in passphrase mode, prompts interactively via the
 * caller-provided `password` prompt (same one the fresh-install
 * branch uses). Dev-mode ledgers don't need a passphrase.
 */
async function resolveExistingMasterKey(
  inPp: boolean,
  password: <T extends { message: string }>(opts: T) => Promise<string>,
): Promise<{ masterKey: Buffer; passphrase: string | undefined }> {
  if (!inPp) {
    return { masterKey: initializeMasterKey(), passphrase: undefined };
  }
  // Passphrase mode: prefer the env var so users can scriptize setup;
  // fall back to an interactive prompt.
  let passphrase = process.env.USRCP_PASSPHRASE;
  if (!passphrase) {
    while (true) {
      const p = await password({ message: "  Passphrase (to unlock your existing ledger):" });
      if (p) { passphrase = p; break; }
      console.log("  Passphrase cannot be empty.");
    }
  }
  // initializeMasterKey throws "Invalid passphrase" on verify mismatch.
  // Surface that clearly; we'd rather fail fast than silently mis-derive.
  let masterKey: Buffer;
  try {
    masterKey = initializeMasterKey(passphrase);
  } catch (err) {
    throw new Error(
      `Failed to unlock ledger: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { masterKey, passphrase };
}

// ---------------------------------------------------------------------------
// Adapter selection step
// ---------------------------------------------------------------------------

/**
 * Filter the registry for the interactive wizard — drops adapters marked
 * hidden, and drops macOS-only adapters on non-Darwin hosts.
 */
export function visibleAdapters(platform: NodeJS.Platform = process.platform): AdapterManifest[] {
  return getRegisteredAdapters().filter((a) => {
    if (a.hidden) return false;
    if (a.requiresMacOS && platform !== "darwin") return false;
    return true;
  });
}

/**
 * Per-adapter Y/N prompts with prereq blurbs surfaced before each prompt.
 * Pure-ish: takes a `confirm` callback so tests can inject a deterministic stub
 * without mocking @inquirer/prompts through the dynamic-import boundary.
 */
export async function selectAdaptersInteractive(
  adapters: AdapterManifest[],
  confirm: (opts: { message: string; default?: boolean }) => Promise<boolean>,
  log: (line: string) => void = console.log,
): Promise<string[]> {
  const chosen: string[] = [];
  for (const adapter of adapters) {
    log(`  ${adapter.name}`);
    log(`  ${adapter.blurb}`);
    const include = await confirm({
      message: `  Configure ${adapter.name}?`,
      default: false,
    });
    log("");
    if (include) chosen.push(adapter.value);
  }
  return chosen;
}

async function pickAdapters(): Promise<string[]> {
  const { confirm } = await getPrompts();

  console.log("\nStep 2 — Adapters");
  console.log("──────────────────");
  console.log("  I'll ask about each adapter individually. Skip any you don't want.\n");

  const chosen = await selectAdaptersInteractive(visibleAdapters(), confirm);

  if (chosen.length === 0) {
    console.log("  No adapters selected. You can run 'usrcp setup' again later to add adapters.");
    console.log("  Your USRCP ledger is still ready for use via MCP-aware CLIs.\n");
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// Adapter setup step
// ---------------------------------------------------------------------------

export async function runAdapterSetups(
  adapters: string[],
  setupFn: (adapter: string) => Promise<void> = callAdapterSetup,
  log: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
): Promise<{ succeeded: string[]; failed: { adapter: string; error: string }[] }> {
  const succeeded: string[] = [];
  const failed: { adapter: string; error: string }[] = [];
  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    const n = i + 3; // steps 3, 4, … (step 1=ledger, step 2=selection)
    const label = adapter.charAt(0).toUpperCase() + adapter.slice(1);
    log(`\nStep ${n} — ${label} adapter`);
    log("─".repeat(40));
    try {
      await setupFn(adapter);
      succeeded.push(adapter);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      err(`  ⚠️  ${label} setup failed or was cancelled: ${message}`);
      err(`     You can retry later with: usrcp setup --adapter=${adapter}\n`);
      failed.push({ adapter, error: message });
    }
  }
  return { succeeded, failed };
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

function printSummary(adapters: string[]): void {
  const usrcpDir = getUsrcpBaseDir();
  console.log("\n  ✓ Setup complete\n");
  console.log("  Ledger:   " + usrcpDir + "/users/");
  for (const a of adapters) {
    // openclaw is read-side only — its setup prints a CLI command rather
    // than writing ~/.usrcp/openclaw-config.json, so skip the config line.
    if (a === "openclaw") continue;
    console.log(`  Config:   ~/.usrcp/${a}-config.json`);
  }
  console.log("");
  console.log("What's next:");
  if (adapters.includes("discord")) {
    console.log("  Start the Discord bot:");
    console.log("    usrcp-discord");
    console.log("    # or: USRCP_PASSPHRASE=<pp> usrcp-discord");
  }
  if (adapters.includes("telegram")) {
    console.log("  Start the Telegram bot:");
    console.log("    usrcp-telegram");
    console.log("    # or: USRCP_PASSPHRASE=<pp> usrcp-telegram");
  }
  if (adapters.includes("slack")) {
    console.log("  Start the Slack bot:");
    console.log("    usrcp-slack");
    console.log("    # or: USRCP_PASSPHRASE=<pp> usrcp-slack");
  }
  if (adapters.includes("imessage")) {
    console.log("  Start the iMessage watcher:");
    console.log("    usrcp-imessage");
    console.log("    # or: USRCP_PASSPHRASE=<pp> usrcp-imessage");
  }
  if (adapters.includes("extension")) {
    console.log("  Browser extension:");
    console.log("    Manifest installed at ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.usrcp.bridge.json");
    console.log("    Load 'packages/usrcp-extension/dist/' in chrome://extensions (Developer Mode → Load Unpacked).");
  }
  if (adapters.includes("openclaw")) {
    console.log("  OpenClaw:");
    console.log("    Run the printed `openclaw mcp set usrcp '...'` command from a shell where openclaw is on PATH.");
    console.log("    Then verify with `openclaw mcp list` and start an OpenClaw session.");
  }
  console.log("");
  console.log("  Add another adapter later:  usrcp setup --adapter=<name>");
  console.log("  Ledger status:              usrcp status");
  console.log("  Reset an adapter:           <adapter-binary> --reset-config");
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  console.log("");
  console.log("  ╦ ╦╔═╗╦═╗╔═╗╔═╗  setup");
  console.log("  ║ ║╚═╗╠╦╝║  ╠═╝");
  console.log("  ╚═╝╚═╝╩╚═╚═╝╩");
  console.log("");

  // Build the master-key gate from manifests once per `usrcp setup`
  // invocation. Adapters with `requiresMasterKey: true` route through
  // `acquireMasterKeyForStandaloneAdapter` below; everything else
  // bypasses the key acquisition so terminal / mcp-agent / etc. don't
  // demand a passphrase the wizard won't use.
  const registered = getRegisteredAdapters();
  const validAdapters = registered.map((x) => x.value);
  const masterKeyRequiringAdapters = getMasterKeyRequiringAdapterValues(registered);

  // If --adapter is given, skip ledger + selection and jump straight to that adapter.
  if (opts.adapter) {
    const a = opts.adapter;
    if (!validAdapters.includes(a)) {
      console.error(`  Unknown adapter '${a}'. Known adapters: ${validAdapters.join(", ")}`);
      process.exit(1);
    }
    const label = a.charAt(0).toUpperCase() + a.slice(1);
    console.log(`  Configuring adapter: ${label}`);
    try {
      let masterKey: Buffer | undefined;
      if (masterKeyRequiringAdapters.has(a)) {
        masterKey = await acquireMasterKeyForStandaloneAdapter();
      }
      try {
        await callAdapterSetup(a, masterKey);
      } finally {
        if (masterKey) masterKey.fill(0);
      }
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Run 'usrcp setup' again to retry.");
      process.exit(1);
    }
    console.log(`\n  ✓ ${label} adapter configured.`);
    return;
  }

  // Full wizard
  try {
    const { masterKey } = await ensureLedger();
    const adapters = await pickAdapters();
    try {
      const { succeeded } = await runAdapterSetups(adapters, (adapter) =>
        callAdapterSetup(adapter, masterKey)
      );
      printSummary(succeeded);
    } finally {
      masterKey.fill(0);
    }
  } catch (err) {
    console.error(`\n  Error during setup: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Run 'usrcp setup' again to retry.");
    process.exit(1);
  }
}

/**
 * Acquire a master key in the --adapter standalone path (no
 * ensureLedger). Reads USRCP_PASSPHRASE in passphrase mode; otherwise
 * loads the dev-mode key off disk. Throws if passphrase mode is set
 * up but no passphrase is available - we can't encrypt config
 * secrets without it.
 */
async function acquireMasterKeyForStandaloneAdapter(): Promise<Buffer> {
  // Resolve the slug first; initializeMasterKey reads the per-user
  // keys/ dir, so the slug has to be set before we call it.
  const slugs = listUserSlugs();
  if (slugs.length === 1) {
    setUserSlug(slugs[0]);
  } else if (slugs.length > 1) {
    throw new Error(
      `Multiple users on this machine (${slugs.join(", ")}). Run 'usrcp setup' (no --adapter) to pick one first.`
    );
  } else {
    throw new Error("No ledger found. Run 'usrcp setup' (no --adapter) to initialize one first.");
  }
  const inPp = isPassphraseMode();
  if (!inPp) {
    return initializeMasterKey();
  }
  const passphrase = process.env.USRCP_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      `Ledger is passphrase-protected but USRCP_PASSPHRASE is not set. Re-run with: USRCP_PASSPHRASE="<your passphrase>" usrcp setup --adapter=...`
    );
  }
  return initializeMasterKey(passphrase);
}
