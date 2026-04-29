/**
 * Pure data-shaping for the Facts tree.
 *
 * Separated from tree-provider.ts so the logic can be unit-tested without
 * loading the `vscode` module (which is only available at runtime inside
 * the editor).
 */

import type { UsrcpFact } from "./mcp-client.js";

export interface DomainNode {
  kind: "domain";
  domain: string;
  factCount: number;
}

export interface FactNode {
  kind: "fact";
  domain: string;
  fact: UsrcpFact;
  /** Label shown in the tree: `namespace/key`. */
  label: string;
  /** Description shown to the right of the label: short preview of the value. */
  description: string;
  /** Tooltip: full pretty-printed value. */
  tooltip: string;
}

export interface EmptyNode {
  kind: "empty";
  message: string;
}

export type TreeNode = DomainNode | FactNode | EmptyNode;

/**
 * Build the top-level list of domain nodes from the status response.
 *
 * Domains with zero facts are still surfaced — `usrcp_status` reports
 * domains that have *events*, not facts, so the user may see a domain
 * appear empty when expanded. That's expected and not an error.
 */
export function shapeDomainNodes(
  domains: string[],
  factsByDomain: ReadonlyMap<string, UsrcpFact[]>,
): DomainNode[] {
  return [...domains]
    .sort((a, b) => a.localeCompare(b))
    .map((domain) => ({
      kind: "domain" as const,
      domain,
      factCount: factsByDomain.get(domain)?.length ?? 0,
    }));
}

/**
 * Build the children for a single domain.
 *
 * Returns a single EmptyNode when the domain has no facts, so VS Code
 * still renders the expansion state with a helpful message instead of
 * a dead-looking empty branch.
 */
export function shapeFactNodes(domain: string, facts: readonly UsrcpFact[]): TreeNode[] {
  if (facts.length === 0) {
    return [{ kind: "empty", message: "(no facts in this domain)" }];
  }

  return [...facts]
    .sort((a, b) => {
      const ns = (a.namespace ?? "").localeCompare(b.namespace ?? "");
      return ns !== 0 ? ns : (a.key ?? "").localeCompare(b.key ?? "");
    })
    .map((fact) => ({
      kind: "fact" as const,
      domain,
      fact,
      label: `${fact.namespace ?? ""}/${fact.key ?? ""}`,
      description: previewValue(fact.value),
      tooltip: prettyValue(fact.value),
    }));
}

/**
 * One-line preview of a fact value for the TreeItem description column.
 *
 * Strings up to 60 chars render as-is; longer strings are truncated with
 * an ellipsis. Objects/arrays render as `{...}` / `[N items]` placeholders.
 */
export function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{...}";
  return String(value);
}

function prettyValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
