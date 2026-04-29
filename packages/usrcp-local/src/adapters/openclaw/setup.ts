/**
 * OpenClaw adapter — registers `usrcp serve` as an MCP server in the
 * user's OpenClaw config so OpenClaw agents can read/write the USRCP
 * ledger via the same 6 MCP tools exposed to Claude Code, Cursor, etc.
 *
 * v1: capture-only path is intentionally out of scope. Users running
 * OpenClaw with multiplexed Discord/Slack/iMessage channels should use
 * the dedicated `usrcp-discord` / `usrcp-slack` / `usrcp-imessage`
 * adapters for capture; this adapter handles the read side only.
 *
 * Like the `mcp-agent` wizard, this prints the exact command for the
 * user to run rather than shelling out to `openclaw mcp set` itself.
 * That avoids two pitfalls:
 *   1. Passphrase mode: auto-writing `env.USRCP_PASSPHRASE` would either
 *      bake in a placeholder OpenClaw would fail with, or capture a
 *      secret into a third-party config without consent.
 *   2. The user may not have the `openclaw` binary on PATH on the
 *      machine where they run `usrcp setup` (e.g., remote install).
 */

import { execSync } from "node:child_process";
import { resolveUsrcpBin } from "../terminal/shared.js";
import { isPassphraseMode } from "../../encryption.js";

export interface OpenclawSetupDeps {
  resolveUsrcpBin?: () => string;
  isPassphraseMode?: () => boolean;
  /** Returns the absolute path to the openclaw binary, or null if not on PATH. */
  whichOpenclaw?: () => string | null;
  log?: (line: string) => void;
}

function defaultWhichOpenclaw(): string | null {
  try {
    const out = execSync("which openclaw", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface OpenclawMcpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildOpenclawMcpServerEntry(
  usrcpBin: string,
  passphraseMode: boolean,
): OpenclawMcpServerEntry {
  const entry: OpenclawMcpServerEntry = {
    command: usrcpBin,
    args: ["serve", "--stdio"],
  };
  if (passphraseMode) {
    entry.env = { USRCP_PASSPHRASE: "<your passphrase>" };
  }
  return entry;
}

export function buildOpenclawMcpSetCommand(entry: OpenclawMcpServerEntry): string {
  // Single-quote the JSON for shell safety. JSON has no embedded single
  // quotes by spec, so this is unambiguous on any POSIX shell.
  return `openclaw mcp set usrcp '${JSON.stringify(entry)}'`;
}

export async function runOpenclawSetup(
  deps: OpenclawSetupDeps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  const usrcpBin = (deps.resolveUsrcpBin ?? resolveUsrcpBin)();
  const passphraseMode = (deps.isPassphraseMode ?? isPassphraseMode)();
  const openclawBin = (deps.whichOpenclaw ?? defaultWhichOpenclaw)();

  const entry = buildOpenclawMcpServerEntry(usrcpBin, passphraseMode);
  const cmd = buildOpenclawMcpSetCommand(entry);

  log("");
  log("  Prerequisite: OpenClaw must already be installed and the `openclaw`");
  log("  CLI must be on your PATH. If you don't have it yet, install it");
  log("  first: https://docs.openclaw.ai/start/getting-started");
  log("");

  if (openclawBin === null) {
    log("  ⚠️  `openclaw` was not found on your PATH. The command below will");
    log("      fail until you install OpenClaw. You can still copy the command");
    log("      and run it later.");
    log("");
  } else {
    log(`  ✓ Found openclaw at ${openclawBin}`);
    log("");
  }

  log("  This wizard prints the command to register USRCP as an MCP server");
  log("  in your OpenClaw config. OpenClaw agents will then have access to");
  log("  all 6 USRCP tools: get_state, append_event, search_timeline,");
  log("  set_fact, get_facts, status.");
  log("");
  log("  Run this command from a shell where the `openclaw` CLI is on PATH:");
  log("");
  log(`    ${cmd}`);
  log("");

  if (passphraseMode) {
    log("  ⚠️  Passphrase mode detected. Replace <your passphrase> in the");
    log("      command above with your actual passphrase before running it.");
    log("      OpenClaw will store the value in its config; treat that file");
    log("      as a secret.");
    log("");
  }

  log("  Verify with:");
  log("    openclaw mcp list                  # 'usrcp' should appear");
  log("    openclaw mcp show usrcp            # full entry");
  log("");
  log("  Smoke test — start a session in OpenClaw and ask:");
  log("    \"What's the most recent event in my USRCP timeline?\"");
  log("");
  log("  To remove later:");
  log("    openclaw mcp unset usrcp");
  log("");
}
