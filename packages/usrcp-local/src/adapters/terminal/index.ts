/**
 * Terminal adapter orchestrator.
 *
 * Dispatches `add`, `remove`, and `list` operations across the set of
 * registered terminal-agent targets. Each target is an independent module
 * that edits one config file with the atomic-write + backup pattern.
 *
 * CLI surface (wired up in packages/usrcp-local/src/index.ts):
 *   usrcp adapter add terminal --targets=claude-code,cursor,codex
 *   usrcp adapter add terminal --all
 *   usrcp adapter remove terminal --targets=cursor
 *   usrcp adapter list
 *   usrcp adapter terminal refresh-context
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveUsrcpBin } from "./shared.js";
import * as claudeCode from "./claude-code.js";
import * as cursor from "./cursor.js";
import * as codex from "./codex.js";
import * as copilotCli from "./copilot-cli.js";
import * as cline from "./cline.js";
import * as continueDev from "./continue.js";
import * as aider from "./aider.js";

export type TargetName = "claude-code" | "cursor" | "codex" | "copilot-cli" | "cline" | "continue" | "aider";

interface TargetModule {
  register(usrcpBin: string): Promise<{ target: string; path: string; ok: boolean; error?: string }>;
  unregister(): Promise<void>;
  status(): Promise<"registered" | "not_registered" | "config_missing">;
}

const TARGETS: Record<TargetName, TargetModule> = {
  "claude-code": claudeCode,
  "cursor": cursor,
  "codex": codex,
  "copilot-cli": copilotCli,
  "cline": cline,
  "continue": continueDev,
  "aider": aider,
};

export const ALL_TARGETS = Object.keys(TARGETS) as TargetName[];

export interface AdapterResult {
  target: string;
  path?: string;
  ok: boolean;
  error?: string;
}

/**
 * Detect which agents appear to be installed on this machine.
 *
 * Detection strategy: check for the agent's binary on PATH OR its config
 * file already existing. Either signal means the user has the tool.
 */
export function detectInstalledTargets(): TargetName[] {
  const home = homedir();

  function hasBinary(bin: string): boolean {
    try {
      execSync(`which ${bin}`, { stdio: ["pipe", "pipe", "pipe"] });
      return true;
    } catch {
      return false;
    }
  }

  const checks: Array<[TargetName, () => boolean]> = [
    ["claude-code", () => hasBinary("claude") || existsSync(join(home, ".claude.json"))],
    ["cursor",      () => hasBinary("cursor") || existsSync(join(home, ".cursor", "mcp.json"))],
    ["codex",       () => hasBinary("codex")  || existsSync(join(home, ".codex", "config.toml"))],
    ["copilot-cli", () => hasBinary("gh")     || existsSync(join(home, ".copilot", "mcp-config.json"))],
    ["cline",       () => {
      // Cline is a VS Code extension — detect via VS Code being present.
      const vscodeExists =
        hasBinary("code") ||
        existsSync(join(home, "Library", "Application Support", "Code")) ||
        existsSync(join(home, ".config", "Code"));
      return vscodeExists;
    }],
    ["continue",    () => hasBinary("continue") || existsSync(join(home, ".continue"))],
    ["aider",       () => hasBinary("aider") || existsSync(join(home, ".aider.conf.yml"))],
  ];

  return checks.filter(([, check]) => {
    try { return check(); } catch { return false; }
  }).map(([name]) => name);
}

/**
 * Register USRCP with the given list of targets.
 * One-target failure doesn't stop the others.
 */
export async function addTerminalAdapter(
  targets: TargetName[],
  usrcpBin: string,
): Promise<AdapterResult[]> {
  const results: AdapterResult[] = [];
  for (const t of targets) {
    const mod = TARGETS[t];
    if (!mod) {
      results.push({ target: t, ok: false, error: `unknown target "${t}"` });
      continue;
    }
    try {
      results.push(await mod.register(usrcpBin));
    } catch (e) {
      results.push({ target: t, ok: false, error: String(e) });
    }
  }
  return results;
}

/**
 * Unregister USRCP from the given list of targets.
 * One-target failure doesn't stop the others.
 */
export async function removeTerminalAdapter(
  targets: TargetName[],
  usrcpBin?: string,
): Promise<AdapterResult[]> {
  void usrcpBin; // not needed for removal
  const results: AdapterResult[] = [];
  for (const t of targets) {
    const mod = TARGETS[t];
    if (!mod) {
      results.push({ target: t, ok: false, error: `unknown target "${t}"` });
      continue;
    }
    try {
      await mod.unregister();
      results.push({ target: t, ok: true });
    } catch (e) {
      results.push({ target: t, ok: false, error: String(e) });
    }
  }
  return results;
}

/**
 * List status of all targets.
 */
export async function listTerminalAdapters(): Promise<
  Array<{ target: TargetName; status: "registered" | "not_registered" | "config_missing" }>
> {
  const rows = [];
  for (const t of ALL_TARGETS) {
    const s = await TARGETS[t].status();
    rows.push({ target: t, status: s });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Wizard-facing setup module
// ---------------------------------------------------------------------------

interface CheckboxChoice<T> {
  name: string;
  value: T;
  checked?: boolean;
  disabled?: boolean | string;
}

export interface TerminalSetupPrompts {
  checkbox<T>(opts: { message: string; choices: CheckboxChoice<T>[] }): Promise<T[]>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

const execFileP = promisify(execFile);

const AIDER_CRON_LINE_TAG = "# usrcp aider context refresh";

export function buildAiderCronLine(usrcpBin: string): string {
  return `*/15 * * * * ${usrcpBin} adapter terminal refresh-context  ${AIDER_CRON_LINE_TAG}`;
}

/**
 * Pure helper: given the existing crontab content and the usrcp binary path,
 * decide whether the entry needs to be added and what the merged crontab
 * should look like.
 *
 * Idempotent: if our tagged line already exists, returns kind: "already_present".
 */
export function planAiderCronUpdate(
  existing: string,
  usrcpBin: string,
): { kind: "already_present" } | { kind: "add"; merged: string } {
  if (existing.includes(AIDER_CRON_LINE_TAG)) return { kind: "already_present" };
  const newLine = buildAiderCronLine(usrcpBin);
  const merged = existing.endsWith("\n") || existing === ""
    ? `${existing}${newLine}\n`
    : `${existing}\n${newLine}\n`;
  return { kind: "add", merged };
}

export interface CrontabIO {
  read(): Promise<string>;            // reads current crontab; throws if none exists
  write(content: string): Promise<void>;
}

const realCrontabIO: CrontabIO = {
  read: async () => {
    const { stdout } = await execFileP("crontab", ["-l"]);
    return stdout;
  },
  write: async (content) => {
    const child = execFile("crontab", ["-"]);
    if (!child.stdin) throw new Error("crontab stdin unavailable");
    child.stdin.write(content);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`crontab exited ${code}`))));
      child.on("error", reject);
    });
  },
};

/**
 * Add a crontab entry that refreshes ~/.usrcp/CONTEXT.md every 15 minutes.
 * Idempotent: if our tagged line already exists, no-op.
 *
 * The `io` parameter is injected for tests; defaults to real crontab I/O.
 */
export async function installAiderCronEntry(
  usrcpBin: string = resolveUsrcpBin(),
  io: CrontabIO = realCrontabIO,
): Promise<"added" | "already_present" | "failed"> {
  let existing = "";
  try {
    existing = await io.read();
  } catch {
    // No crontab yet, or read errored. Treat as empty.
    existing = "";
  }

  const plan = planAiderCronUpdate(existing, usrcpBin);
  if (plan.kind === "already_present") return "already_present";

  try {
    await io.write(plan.merged);
    return "added";
  } catch {
    return "failed";
  }
}

/**
 * Wizard step that registers USRCP with detected CLI agents.
 *
 * Auto-detects which agents are installed, presents a multi-select with
 * detected ones pre-checked and undetected ones disabled, then calls the
 * existing addTerminalAdapter() with the user's choices. For Aider,
 * additionally offers to install the cron entry that refreshes CONTEXT.md.
 */
export async function runTerminalSetup(prompts: TerminalSetupPrompts): Promise<void> {
  const detected = new Set(detectInstalledTargets());
  const usrcpBin = resolveUsrcpBin();

  console.log("");
  console.log("  USRCP wires into MCP-aware CLI agents via their config files.");
  console.log("  Detected agents are pre-checked. Undetected agents are skipped.");
  console.log("");

  const choices: CheckboxChoice<TargetName>[] = ALL_TARGETS.map((t) => {
    const isDetected = detected.has(t);
    return {
      name: isDetected ? `${t} (detected)` : `${t}`,
      value: t,
      checked: isDetected,
      disabled: isDetected ? false : "(not detected — install first)",
    };
  });

  const targets = await prompts.checkbox({
    message: "  Which CLI agents do you want USRCP wired into?",
    choices,
  });

  if (targets.length === 0) {
    console.log("  No CLI agents selected. Skipping terminal adapter.");
    return;
  }

  const results = await addTerminalAdapter(targets, usrcpBin);

  for (const r of results) {
    if (r.ok) {
      const pathSuffix = r.path ? ` (${r.path})` : "";
      console.log(`  [ok] Registered with ${r.target}${pathSuffix}`);
    } else {
      console.log(`  [fail] ${r.target}: ${r.error}`);
    }
  }

  if (targets.includes("aider")) {
    console.log("");
    console.log("  Aider doesn't speak MCP — it consumes a context file instead.");
    console.log("  USRCP can write ~/.usrcp/CONTEXT.md from the ledger every 15 minutes.");

    const installCron = await prompts.confirm({
      message: "  Install the cron entry to refresh CONTEXT.md?",
      default: true,
    });

    if (installCron) {
      const result = await installAiderCronEntry(usrcpBin);
      if (result === "added") {
        console.log("  [ok] Cron entry installed.");
      } else if (result === "already_present") {
        console.log("  [ok] Cron entry already present — no change.");
      } else {
        console.log("  [warn] Could not install cron entry. Add manually:");
        console.log(`     ${buildAiderCronLine(usrcpBin)}`);
      }
    }
  }

  console.log("");
  console.log("  Restart your terminal session for changes to take effect.");
}

/**
 * Parse a comma-separated --targets= value into validated TargetName[].
 * Returns null (with error printed) on invalid input.
 */
export function parseTargets(raw: string): TargetName[] | null {
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: TargetName[] = [];
  for (const n of names) {
    if (!ALL_TARGETS.includes(n as TargetName)) {
      console.error(
        `  Error: unknown terminal target "${n}". Known: ${ALL_TARGETS.join(", ")}`,
      );
      return null;
    }
    if (!out.includes(n as TargetName)) out.push(n as TargetName);
  }
  return out;
}
