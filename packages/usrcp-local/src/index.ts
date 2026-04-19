#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { Ledger } from "./ledger.js";
import { initializeIdentity, getIdentity } from "./crypto.js";
import { isPassphraseMode } from "./encryption.js";

const USRCP_DIR = path.join(os.homedir(), ".usrcp");

function printBanner(): void {
  console.error(`
  ╦ ╦╔═╗╦═╗╔═╗╔═╗
  ║ ║╚═╗╠╦╝║  ╠═╝
  ╚═╝╚═╝╩╚═╚═╝╩   v0.1.0

  User Context Protocol — Local Ledger
  `);
}

/**
 * Get passphrase from:
 * 1. --passphrase CLI flag
 * 2. USRCP_PASSPHRASE environment variable
 * 3. undefined (dev mode)
 */
function getPassphrase(): string | undefined {
  // Check CLI flag: --passphrase=xxx or --passphrase xxx
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--passphrase" && args[i + 1]) {
      return args[i + 1];
    }
    if (args[i].startsWith("--passphrase=")) {
      return args[i].split("=").slice(1).join("=");
    }
  }

  // Check environment variable
  if (process.env.USRCP_PASSPHRASE) {
    return process.env.USRCP_PASSPHRASE;
  }

  return undefined;
}

function cmdInit(): void {
  printBanner();

  const passphrase = getPassphrase();

  // Initialize identity and keys
  const identity = initializeIdentity();
  console.error(`  User ID:  ${identity.user_id}`);
  console.error(`  Keys:     ${USRCP_DIR}/keys/`);
  console.error(`  Ledger:   ${USRCP_DIR}/ledger.db`);
  console.error(`  Mode:     ${passphrase ? "passphrase-protected" : "dev (key on disk)"}`);

  // Create the ledger DB (constructor handles migration)
  const ledger = new Ledger(undefined, passphrase);
  ledger.close();

  // Register as MCP server in Claude Code config
  registerMcpServer();

  console.error(`
  ✓ USRCP local ledger initialized.
  ${passphrase
    ? "  ⚠ Passphrase mode: set USRCP_PASSPHRASE env var before starting.\n    The key exists only in memory while the server runs."
    : "  Your AI agents now have persistent memory."
  }

  To start the MCP server manually:
    usrcp-local serve

  Claude Code will auto-start it via MCP config.
  `);
}

function registerMcpServer(): void {
  const claudeDir = path.join(os.homedir(), ".claude");
  const mcpConfigPath = path.join(claudeDir, "mcp_servers.json");

  fs.mkdirSync(claudeDir, { recursive: true });

  let config: Record<string, any> = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  const serverPath = path.resolve(__dirname, "index.js");
  config["usrcp-local"] = {
    command: "node",
    args: [serverPath, "serve"],
  };

  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  console.error(`  MCP:      Registered in ${mcpConfigPath}`);
}

function cmdStatus(): void {
  printBanner();

  const identity = getIdentity();
  if (!identity) {
    console.error("  Not initialized. Run: usrcp-local init");
    process.exit(1);
  }

  const passphraseRequired = isPassphraseMode();
  const passphrase = passphraseRequired ? getPassphrase() : undefined;

  if (passphraseRequired && !passphrase) {
    console.error("  This ledger is passphrase-protected.");
    console.error("  Provide passphrase via --passphrase or USRCP_PASSPHRASE env var.");
    process.exit(1);
  }

  const ledger = new Ledger(undefined, passphrase);
  const stats = ledger.getStats();
  ledger.close();

  console.error(`  User ID:       ${identity.user_id}`);
  console.error(`  Created:       ${identity.created_at}`);
  console.error(`  Mode:          ${passphraseRequired ? "passphrase-protected" : "dev"}`);
  console.error(`  Key version:   ${stats.encryption_enabled ? "active" : "none"}`);
  console.error(`  Total Events:  ${stats.total_events}`);
  console.error(`  Total Projects:${stats.total_projects}`);
  console.error(`  Audit entries: ${stats.audit_log_entries}`);
  console.error(`  DB size:       ${(stats.db_size_bytes / 1024).toFixed(1)} KB`);
  console.error(`  Domains:       ${stats.domains.join(", ") || "(none)"}`);
  console.error(`  Platforms:     ${stats.platforms.join(", ") || "(none)"}`);
}

async function cmdServe(): Promise<void> {
  const identity = getIdentity();
  if (!identity) {
    initializeIdentity();
  }

  const passphraseRequired = isPassphraseMode();
  const passphrase = passphraseRequired ? getPassphrase() : undefined;

  if (passphraseRequired && !passphrase) {
    console.error("[usrcp-local] This ledger is passphrase-protected.");
    console.error("[usrcp-local] Set USRCP_PASSPHRASE env var to unlock.");
    process.exit(1);
  }

  const { server, shutdown } = createServer(passphrase);
  const transport = new StdioServerTransport();

  const handleShutdown = () => {
    console.error("[usrcp-local] Shutting down...");
    shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);

  await server.connect(transport);
  console.error(`[usrcp-local] MCP server running on stdio (${passphraseRequired ? "passphrase mode" : "dev mode"})`);
}

// --- CLI Router ---
const command = process.argv[2];

switch (command) {
  case "init":
    cmdInit();
    break;
  case "serve":
    cmdServe().catch((err) => {
      console.error("[usrcp-local] Fatal:", err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    });
    break;
  case "status":
    cmdStatus();
    break;
  default:
    if (!command) {
      cmdServe().catch((err) => {
        console.error("[usrcp-local] Fatal:", err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      });
    } else {
      printBanner();
      console.error(`  Usage: usrcp-local <command> [options]

  Commands:
    init      Initialize local ledger and register MCP server
    serve     Start MCP server on stdio
    status    Show ledger status and statistics

  Options:
    --passphrase <value>    Passphrase for encryption key derivation
                            Or set USRCP_PASSPHRASE environment variable

  Passphrase mode:
    usrcp-local init --passphrase "my secret phrase"
    USRCP_PASSPHRASE="my secret phrase" usrcp-local serve
  `);
    }
}
