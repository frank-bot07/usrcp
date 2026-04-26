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
} from "./encryption.js";
import { initializeIdentity } from "./crypto.js";
import { Ledger } from "./ledger/index.js";

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

interface CheckboxChoice<T> { name: string; value: T; }
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
 */
async function callAdapterSetup(adapterName: string): Promise<void> {
  // __dirname in dist/ is packages/usrcp-local/dist/
  // We need to go two levels up to reach packages/
  const localPkgDir = path.resolve(__dirname, ".."); // packages/usrcp-local
  const monoRoot = path.resolve(localPkgDir, "..");   // packages/
  const adapterPkg = `usrcp-${adapterName}`;
  const setupPath = path.join(monoRoot, adapterPkg, "dist", "setup.js");

  if (!fs.existsSync(setupPath)) {
    throw new Error(
      `Cannot find setup module for adapter '${adapterName}' at:\n  ${setupPath}\n` +
      `Make sure 'npm run build' has been run inside packages/${adapterPkg}/.`
    );
  }

  // Dynamic import of the compiled JS (adapter packages are ESM-compatible)
  const mod = await import(setupPath) as Record<string, unknown>;

  // Convention: runDiscordSetup, runTelegramSetup, etc.
  const fnName = `run${adapterName.charAt(0).toUpperCase()}${adapterName.slice(1)}Setup`;
  const fn = mod[fnName] as ((...args: unknown[]) => Promise<unknown>) | undefined;
  if (typeof fn !== "function") {
    throw new Error(
      `Adapter module at ${setupPath} does not export '${fnName}'.`
    );
  }
  await fn();
}

// ---------------------------------------------------------------------------
// Ledger step
// ---------------------------------------------------------------------------

async function ensureLedger(): Promise<void> {
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
  } else {
    // Multiple users — require explicit selection
    const chosen = await select({
      message: "  Multiple users found. Which one should setup configure?",
      choices: slugs.map((s) => ({ name: s, value: s })),
    });
    setUserSlug(chosen);
    console.log(`  ✓ Using user "${chosen}".`);
  }
}

// ---------------------------------------------------------------------------
// Adapter selection step
// ---------------------------------------------------------------------------

const KNOWN_ADAPTERS = [
  { name: "Discord", value: "discord" },
  { name: "Telegram", value: "telegram" },
] as const;

type KnownAdapterValue = (typeof KNOWN_ADAPTERS)[number]["value"];

async function pickAdapters(): Promise<KnownAdapterValue[]> {
  const { checkbox } = await getPrompts();

  console.log("\nStep 2 — Adapters");
  console.log("──────────────────");
  console.log("  Which adapters do you want to configure? (Space to select, Enter to confirm)");

  const chosen = await checkbox({
    message: "  Select adapters:",
    choices: KNOWN_ADAPTERS.map((a) => ({ name: a.name, value: a.value })),
    validate: (answer) => answer.length > 0 || "Select at least one adapter.",
  });

  return chosen as KnownAdapterValue[];
}

// ---------------------------------------------------------------------------
// Adapter setup step
// ---------------------------------------------------------------------------

async function runAdapterSetups(adapters: string[]): Promise<void> {
  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    const n = i + 3; // steps 3, 4, … (step 1=ledger, step 2=selection)
    const label = adapter.charAt(0).toUpperCase() + adapter.slice(1);
    console.log(`\nStep ${n} — ${label} adapter`);
    console.log("─".repeat(40));
    await callAdapterSetup(adapter);
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

function printSummary(adapters: string[]): void {
  const usrcpDir = getUsrcpBaseDir();
  console.log("\n  ✓ Setup complete\n");
  console.log("  Ledger:   " + usrcpDir + "/users/");
  for (const a of adapters) {
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

  const validAdapters = KNOWN_ADAPTERS.map((x) => x.value) as readonly string[];

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
      await callAdapterSetup(a);
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
    await ensureLedger();
    const adapters = await pickAdapters();
    await runAdapterSetups(adapters);
    printSummary(adapters);
  } catch (err) {
    console.error(`\n  Error during setup: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Run 'usrcp setup' again to retry.");
    process.exit(1);
  }
}
