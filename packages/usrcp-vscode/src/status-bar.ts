/**
 * Status bar item: surfaces connection state and a quick fact/event count.
 */

import * as vscode from "vscode";

import type { UsrcpClient, UsrcpStatus } from "./mcp-client.js";

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly client: UsrcpClient) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    this.item.command = "usrcp.status";
    this.setDisconnected();
    this.item.show();
  }

  async update(): Promise<void> {
    if (!this.client.isConnected()) {
      this.setDisconnected();
      return;
    }
    try {
      const status: UsrcpStatus = await this.client.getStatus();
      this.item.text = `$(database) USRCP: ${status.total_events} events, ${status.domains.length} domains`;
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**USRCP — connected**`,
          ``,
          `- Events: \`${status.total_events}\``,
          `- Domains: \`${status.domains.length}\``,
          `- Projects: \`${status.total_projects}\``,
          `- Encryption: \`${status.encryption_enabled ? "on" : "off"}\``,
        ].join("\n"),
      );
      this.item.backgroundColor = undefined;
    } catch (err) {
      this.item.text = `$(warning) USRCP: error`;
      this.item.tooltip = err instanceof Error ? err.message : String(err);
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
  }

  private setDisconnected(): void {
    this.item.text = `$(circle-slash) USRCP: not connected`;
    this.item.tooltip = "Click to view USRCP status";
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  dispose(): void {
    this.item.dispose();
  }
}
