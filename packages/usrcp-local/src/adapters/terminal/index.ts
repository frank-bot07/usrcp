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
