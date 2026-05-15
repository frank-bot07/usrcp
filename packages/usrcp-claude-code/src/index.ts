#!/usr/bin/env node
/**
 * USRCP Claude Code adapter entry point.
 *
 *   usrcp-claude-code                # tail allowlisted projects -> stream
 *   usrcp-claude-code --reset-config # re-run 'usrcp setup --adapter=claude-code'
 *   usrcp-claude-code --once         # run a single poll cycle, exit
 *
 * Requires:
 *   - usrcp-stream installed (this adapter is stream-only; the ledger
 *     has no useful representation of turn-by-turn conversational
 *     content).
 *   - USRCP_PASSPHRASE env var if the local ledger is passphrase
 *     protected.
 *   - At least one entry in `~/.usrcp/claude-code-config.json`'s
 *     `allowlisted_projects` (default empty -> no-op).
 */

import { execSync } from "node:child_process";
import { Ledger } from "usrcp-local/dist/ledger/index.js";
import { getUserDir } from "usrcp-local/dist/encryption.js";
import { loadConfig, flushOffsets } from "./config.js";
import { makeWatcher } from "./watcher.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function streamInstalled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve("usrcp-stream/dist/capture-client.js");
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  if (hasFlag("reset-config")) {
    console.error("[usrcp-claude-code] --reset-config: launching 'usrcp setup --adapter=claude-code'...");
    try {
      execSync("usrcp setup --adapter=claude-code", { stdio: "inherit" });
    } catch {
      return 1;
    }
    return 0;
  }

  if (!streamInstalled()) {
    console.error(
      "[usrcp-claude-code] usrcp-stream is required but not resolvable from this package.\n" +
        "  Install it (npm install from this package's directory) and retry."
    );
    return 1;
  }

  const config = loadConfig();
  if (config.allowlisted_projects.length === 0) {
    console.error(
      "[usrcp-claude-code] no projects allowlisted. Edit ~/.usrcp/claude-code-config.json\n" +
        '  or run --reset-config and add one or more absolute project paths to\n' +
        '  "allowlisted_projects". Nothing to do; exiting cleanly.'
    );
    return 0;
  }

  const passphrase = process.env.USRCP_PASSPHRASE;
  const ledger = new Ledger(undefined, passphrase);

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const streamMod = require("usrcp-stream/dist/capture-client.js") as any;
  const streamClient = streamMod.createStreamCaptureClient(
    ledger.getMasterKey(),
    getUserDir(),
    { ledger }
  );

  console.error(
    `[usrcp-claude-code] watching ${config.allowlisted_projects.length} project(s): ` +
      config.allowlisted_projects.join(", ")
  );

  const watcher = makeWatcher(config, streamClient, {
    onTickStats: (stats) => {
      if (stats.eventsCaptured > 0 || stats.errors > 0) {
        console.error(
          `[usrcp-claude-code] tick: captured=${stats.eventsCaptured} ` +
            `skipped=${stats.linesSkipped} errors=${stats.errors} ` +
            `trunc=${stats.truncationsDetected} files=${stats.filesScanned}`
        );
      }
    },
  });

  if (hasFlag("once")) {
    const stats = await watcher.poll();
    console.error(
      `[usrcp-claude-code] --once complete: captured=${stats.eventsCaptured} ` +
        `processed=${stats.linesProcessed} skipped=${stats.linesSkipped} ` +
        `errors=${stats.errors}`
    );
    flushOffsets();
    try { streamClient.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    return 0;
  }

  const stop = watcher.start();

  const shutdown = (signal: string) => {
    console.error(`[usrcp-claude-code] ${signal} received, shutting down.`);
    try { stop(); } catch { /* ignore */ }
    try { streamClient.close(); } catch { /* ignore */ }
    try { ledger.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the event loop alive; the poll timer holds it open.
  return new Promise<number>(() => {
    // Resolved only when the signal handler exits the process.
  });
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("[usrcp-claude-code] fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
