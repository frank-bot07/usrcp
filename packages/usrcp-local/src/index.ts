#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { initializeIdentity, getIdentity } from "./crypto.js";

const USRCP_DIR = path.join(process.env.HOME || "~", ".usrcp");

function printBanner(): void {
  console.error(`
  ╦ ╦╔═╗╦═╗╔═╗╔═╗
  ║ ║╚═╗╠╦╝║  ╠═╝
  ╚═╝╚═╝╩╚═╚═╝╩   v0.1.0

  User Context Protocol — Local Ledger
  `);
}

function cmdInit(): void {
  printBanner();

  // Initialize identity and keys
  const identity = initializeIdentity();
  console.error(`  User ID:  ${identity.user_id}`);
  console.error(`  Keys:     ${USRCP_DIR}/keys/`);
  console.error(`  Ledger:   ${USRCP_DIR}/ledger.db`);

  // Create the ledger DB (constructor handles migration)
  const { Ledger } = require("./ledger.js");
  const ledger = new Ledger();
  ledger.close();

  // Register as MCP server in Claude Code config
  registerMcpServer();

  console.error(`
  ✓ USRCP local ledger initialized.

  Your AI agents now have persistent memory.

  To start the MCP server manually:
    usrcp-local serve

  Claude Code will auto-start it via MCP config.
  `);
}

function registerMcpServer(): void {
  // Claude Code MCP config
  const claudeDir = path.join(process.env.HOME || "~", ".claude");
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

  // Find the built index.js path
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

  const { Ledger } = require("./ledger.js");
  const ledger = new Ledger();
  const stats = ledger.getStats();
  ledger.close();

  console.error(`  User ID:       ${identity.user_id}`);
  console.error(`  Created:       ${identity.created_at}`);
  console.error(`  Total Events:  ${stats.total_events}`);
  console.error(`  Total Projects:${stats.total_projects}`);
  console.error(`  Domains:       ${stats.domains.join(", ") || "(none)"}`);
  console.error(`  Platforms:     ${stats.platforms.join(", ") || "(none)"}`);
}

async function cmdServe(): Promise<void> {
  // Ensure initialized
  const identity = getIdentity();
  if (!identity) {
    initializeIdentity();
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio transport
  console.error("[usrcp-local] MCP server running on stdio");
}

// --- CLI Router ---
const command = process.argv[2];

switch (command) {
  case "init":
    cmdInit();
    break;
  case "serve":
    cmdServe().catch((err) => {
      console.error("[usrcp-local] Fatal:", err);
      process.exit(1);
    });
    break;
  case "status":
    cmdStatus();
    break;
  default:
    // If launched with no args by MCP runtime, default to serve
    if (!command) {
      cmdServe().catch((err) => {
        console.error("[usrcp-local] Fatal:", err);
        process.exit(1);
      });
    } else {
      printBanner();
      console.error(`  Usage: usrcp-local <command>

  Commands:
    init      Initialize local ledger and register MCP server
    serve     Start MCP server on stdio
    status    Show ledger status and statistics
  `);
    }
}
