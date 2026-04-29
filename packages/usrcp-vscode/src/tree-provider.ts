/**
 * VS Code TreeDataProvider for the Facts view.
 *
 * Bridges the pure shapers in tree-shape.ts to the VS Code API. All data
 * shaping logic lives in tree-shape; this file only wires events and
 * converts shaped nodes to TreeItems.
 */

import * as vscode from "vscode";

import type { UsrcpClient, UsrcpFact, UsrcpStatus } from "./mcp-client.js";
import {
  shapeDomainNodes,
  shapeFactNodes,
  type TreeNode,
} from "./tree-shape.js";

export class FactsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private domains: string[] = [];
  private factsByDomain = new Map<string, UsrcpFact[]>();
  private lastError: string | null = null;

  constructor(private readonly client: UsrcpClient) {}

  /**
   * Re-fetch status (for the domain list) and per-domain facts. Called on
   * activation and from the `usrcp.refresh` command.
   */
  async refresh(): Promise<void> {
    try {
      const status: UsrcpStatus = await this.client.getStatus();
      this.domains = status.domains ?? [];
      this.factsByDomain = new Map();
      for (const domain of this.domains) {
        try {
          const facts = await this.client.listFacts(domain);
          this.factsByDomain.set(domain, facts);
        } catch {
          this.factsByDomain.set(domain, []);
        }
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.domains = [];
      this.factsByDomain = new Map();
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "domain") {
      const item = new vscode.TreeItem(
        node.domain,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${node.factCount} fact${node.factCount === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "usrcp.domain";
      return item;
    }
    if (node.kind === "fact") {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.description;
      item.tooltip = new vscode.MarkdownString().appendCodeblock(node.tooltip, "json");
      item.iconPath = new vscode.ThemeIcon("symbol-key");
      item.contextValue = "usrcp.fact";
      return item;
    }
    const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (this.lastError) {
      return [{ kind: "empty", message: `Error: ${this.lastError}` }];
    }
    if (!element) {
      const domains = shapeDomainNodes(this.domains, this.factsByDomain);
      if (domains.length === 0) {
        return [{ kind: "empty", message: "(no domains yet — start a session with USRCP wired in)" }];
      }
      return domains;
    }
    if (element.kind === "domain") {
      return shapeFactNodes(element.domain, this.factsByDomain.get(element.domain) ?? []);
    }
    return [];
  }
}
