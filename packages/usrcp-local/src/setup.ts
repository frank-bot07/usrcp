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
async function callAdapterSetup(adapterName: string): Promise<void> {
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

export interface AdapterSpec {
  name: string;
  value: string;
  blurb: string;
  /** When true, hide on non-Darwin platforms. */
  requiresMacOS?: boolean;
  /** When true, hide from the interactive wizard list. Still selectable via `--adapter=<value>`. */
  hidden?: boolean;
}

export const KNOWN_ADAPTERS: readonly AdapterSpec[] = [
  {
    name: "Terminal / CLI agents (Claude Code, Cursor, Codex, etc.)",
    value: "terminal",
    blurb: "RECOMMENDED. Wires USRCP into your MCP-aware CLI agents (Claude Code, Cursor, Codex, Copilot CLI, Cline, Continue, Aider) so every terminal session has cross-platform memory. No external accounts or bot tokens required.",
  },
  {
    name: "Discord",
    value: "discord",
    blurb: "Free. Requires a Discord account, a server you control, and an Anthropic API key.",
  },
  {
    name: "Telegram",
    value: "telegram",
    blurb: "Free. Requires a Telegram account and an Anthropic API key. Mobile-friendly setup via BotFather.",
  },
  {
    name: "Slack",
    value: "slack",
    blurb: "⚠️  Requires a PAID Slack workspace tier (Pro, Business+, or Enterprise) — bot APIs are restricted on the free tier. Skip this if your workspace is on the free plan.",
  },
  {
    name: "iMessage (macOS)",
    value: "imessage",
    blurb: "macOS only. Requires Full Disk Access for Messages.app + the imsg CLI (brew install steipete/tap/imsg).",
    requiresMacOS: true,
  },
  {
    name: "Obsidian (local vault)",
    value: "obsidian",
    blurb: "Capture notes from a local Obsidian vault. Watches the vault directory and appends each note edit to the ledger. v0: capture-only, no replies.",
  },
  {
    name: "Browser extension (Chrome)",
    value: "extension",
    blurb: "Capture claude.ai conversations and inject ledger context via /usrcp slash command. Chrome only in v0; requires manual extension load (Developer Mode → Load Unpacked).",
  },
  {
    name: "Scoped MCP agent (per-process restriction)",
    value: "mcp-agent",
    blurb: "Generate an MCP config snippet that runs `usrcp serve` with --scopes / --readonly / --no-audit so one agent (e.g. Cursor) can only see a subset of your domains. Use this in addition to (not instead of) the terminal adapter. Run via `usrcp setup --adapter=mcp-agent`.",
    hidden: true,
  },
];

/**
 * Filter the registry for the interactive wizard — drops adapters marked
 * hidden, and drops macOS-only adapters on non-Darwin hosts.
 */
export function visibleAdapters(platform: NodeJS.Platform = process.platform): AdapterSpec[] {
  return KNOWN_ADAPTERS.filter((a) => {
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
  adapters: AdapterSpec[],
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
    const { succeeded } = await runAdapterSetups(adapters);
    printSummary(succeeded);
  } catch (err) {
    console.error(`\n  Error during setup: ${err instanceof Error ? err.message : String(err)}`);
    console.error("  Run 'usrcp setup' again to retry.");
    process.exit(1);
  }
}
