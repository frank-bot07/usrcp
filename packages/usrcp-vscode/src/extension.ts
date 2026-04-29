/**
 * VS Code extension entry — activate / deactivate hooks.
 *
 * Wires together: MCP client (spawns `usrcp serve --transport=stdio`),
 * Facts TreeView, status bar, and three commands (refresh, status,
 * open ledger directory).
 *
 * The extension is read-only by design. Write paths (set_fact,
 * append_event) are reserved for autonomous agents — see roadmap
 * direction confirmed 2026-04-29.
 */

import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";

import { BinaryNotFoundError, UsrcpClient } from "./mcp-client.js";
import { FactsTreeProvider } from "./tree-provider.js";
import { StatusBar } from "./status-bar.js";

let client: UsrcpClient | null = null;
let statusBar: StatusBar | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new UsrcpClient();
  statusBar = new StatusBar(client);

  const treeProvider = new FactsTreeProvider(client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("usrcp.facts", treeProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("usrcp.refresh", async () => {
      await connectIfNeeded();
      await treeProvider.refresh();
      await statusBar?.update();
    }),
    vscode.commands.registerCommand("usrcp.status", () => showStatus(client!)),
    vscode.commands.registerCommand("usrcp.openLedgerDir", () => openLedgerDir()),
  );

  context.subscriptions.push({
    dispose: async () => {
      statusBar?.dispose();
      await client?.dispose();
    },
  });

  // Initial connection — non-fatal: failures show in the tree + status bar.
  await connectIfNeeded();
  await treeProvider.refresh();
  await statusBar.update();
}

export async function deactivate(): Promise<void> {
  statusBar?.dispose();
  await client?.dispose();
  statusBar = null;
  client = null;
}

async function connectIfNeeded(): Promise<void> {
  if (!client || client.isConnected()) return;
  const config = vscode.workspace.getConfiguration("usrcp");
  const binaryPath = config.get<string>("binaryPath", "");
  const user = config.get<string>("user", "");

  try {
    await client.connect({ binaryPath, user });
  } catch (err) {
    if (err instanceof BinaryNotFoundError) {
      vscode.window.showErrorMessage(
        `USRCP: ${err.message}`,
        "Open Settings",
      ).then((choice) => {
        if (choice === "Open Settings") {
          vscode.commands.executeCommand("workbench.action.openSettings", "usrcp.binaryPath");
        }
      });
    } else {
      vscode.window.showErrorMessage(
        `USRCP: failed to connect — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function showStatus(c: UsrcpClient): Promise<void> {
  if (!c.isConnected()) {
    vscode.window.showWarningMessage("USRCP is not connected.");
    return;
  }
  try {
    const status = await c.getStatus();
    const lines = [
      `Events: ${status.total_events}`,
      `Projects: ${status.total_projects}`,
      `Domains: ${status.domains.join(", ") || "(none)"}`,
      `Platforms: ${status.platforms.join(", ") || "(none)"}`,
      `DB size: ${(status.db_size_bytes / 1024).toFixed(1)} KB`,
      `Audit log entries: ${status.audit_log_entries}`,
      `Encryption: ${status.encryption_enabled ? "on" : "off"}`,
    ];
    vscode.window.showInformationMessage(lines.join(" · "), { modal: false });
  } catch (err) {
    vscode.window.showErrorMessage(
      `USRCP status failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function openLedgerDir(): Promise<void> {
  const dir = process.env.USRCP_HOME || join(homedir(), ".usrcp");
  const uri = vscode.Uri.file(dir);
  await vscode.commands.executeCommand("revealFileInOS", uri);
}
