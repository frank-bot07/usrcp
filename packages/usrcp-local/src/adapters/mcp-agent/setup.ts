/**
 * MCP-agent (scoped) wizard.
 *
 * Generates a per-process scoped `usrcp serve` invocation + MCP config
 * snippet for one agent. Use this when an MCP-aware agent (Cursor, Claude
 * Code, …) should only see a subset of the user's domains, or be denied
 * mutating tools, or be denied access to the audit log.
 *
 * This wizard does NOT write to any agent config file — the terminal
 * adapter handles the unrestricted single-agent path. The output is a
 * snippet the operator pastes into the agent's MCP config themselves.
 */

import { resolveUsrcpBin } from "../terminal/shared.js";
import { isPassphraseMode } from "../../encryption.js";

interface Prompts {
  input(opts: { message: string; default?: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

function validateAgentId(s: string): string | true {
  if (s.length === 0) return "Agent name cannot be empty.";
  if (s.length > 100) return "Agent name must be ≤ 100 chars.";
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    return "Use only letters, numbers, dot, underscore, dash.";
  }
  return true;
}

function validateScopes(s: string): string | true {
  const trimmed = s.trim();
  if (trimmed.length === 0) return "Provide a comma-separated list of domains, or 'all'.";
  if (trimmed === "all") return true;
  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "Provide at least one domain.";
  for (const p of parts) {
    if (p.length > 100) return `Domain "${p.slice(0, 20)}…" exceeds 100 chars.`;
  }
  return true;
}

export async function runMcpAgentSetup(prompts: Prompts): Promise<void> {
  console.log("");
  console.log("  This wizard generates a scoped MCP server config for one agent.");
  console.log("  Use it when you want one agent (e.g. Cursor) to only see a subset");
  console.log("  of your domains, run read-only, or be denied the audit-log tool.");
  console.log("");

  // Step 1 — agent name
  let agentId = "";
  while (true) {
    agentId = (
      await prompts.input({
        message: "  Agent name (used as --agent-id, logged with every call):",
        default: "cursor-coding",
      })
    ).trim();
    const v = validateAgentId(agentId);
    if (v === true) break;
    console.log(`  ${v}`);
  }

  // Step 2 — scopes
  console.log("  Tip: see existing domains with `usrcp status`. Common: coding, personal, work.");
  let scopesArg = "";
  while (true) {
    scopesArg = (
      await prompts.input({
        message: "  Scopes (comma-separated domains, or 'all' for full access):",
        default: "coding",
      })
    ).trim();
    const v = validateScopes(scopesArg);
    if (v === true) break;
    console.log(`  ${v}`);
  }
  const scopes =
    scopesArg === "all"
      ? null
      : scopesArg.split(",").map((s) => s.trim()).filter(Boolean);

  // Step 3 — readonly
  const readonly = await prompts.confirm({
    message: "  Read-only mode? (drops mutating tools — recommended for review-only agents)",
    default: false,
  });

  // Step 4 — no-audit
  const noAudit = await prompts.confirm({
    message: "  Hide usrcp_audit_log? (recommended — prevents the agent reading audit history)",
    default: true,
  });

  // Build the args array
  const args: string[] = ["serve", "--stdio", `--agent-id=${agentId}`];
  if (scopes) args.push(`--scopes=${scopes.join(",")}`);
  if (readonly) args.push("--readonly");
  if (noAudit) args.push("--no-audit");

  const usrcpBin = resolveUsrcpBin();

  // Print the test command
  console.log("");
  console.log("  ✓ Configuration ready.");
  console.log("");
  console.log("  Test it from your shell:");
  console.log(`    ${usrcpBin} ${args.join(" ")}`);
  console.log("    (Ctrl-C to exit; this opens an MCP stdio session.)");
  console.log("");

  // Build the MCP config snippet
  const serverKey = `usrcp-${agentId}`;
  const env: Record<string, string> = {};
  if (isPassphraseMode()) env.USRCP_PASSPHRASE = "<your passphrase>";

  const snippet = {
    mcpServers: {
      [serverKey]: {
        command: usrcpBin,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    },
  };

  console.log("  MCP config snippet (paste into your agent's MCP config file):");
  console.log("  ────────────────────────────────────────────────────────────");
  console.log(JSON.stringify(snippet, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  console.log("  ────────────────────────────────────────────────────────────");
  console.log("");
  console.log("  Common MCP config locations:");
  console.log("    Cursor:       ~/.cursor/mcp.json");
  console.log("    Claude Code:  ~/.claude.json (under \"mcpServers\")");
  console.log("    Cline:        VS Code → Cline settings → MCP Servers");
  console.log("    Continue:     ~/.continue/config.json (mcpServers)");
  console.log("");
  if (isPassphraseMode()) {
    console.log("  ⚠️  Replace <your passphrase> in the env block above before saving.");
    console.log("");
  }
  console.log(`  Saved as: ${serverKey}`);
  if (scopes) {
    console.log(`  Scopes:   ${scopes.join(", ")}`);
  } else {
    console.log("  Scopes:   <unrestricted>");
  }
  console.log(`  Mode:     ${readonly ? "read-only" : "read+write"}${noAudit ? ", audit hidden" : ""}`);
  console.log("");
}
