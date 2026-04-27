/**
 * Tests for per-process scope enforcement (Model A) on the MCP server.
 *
 * Covers:
 *   - Registration-time filtering: --readonly drops mutating tools, --no-audit
 *     drops the audit-log tool. Filtered tools are absent from tools/list.
 *   - Domain enforcement: --scopes=<csv> rejects domain-scoped tools targeting
 *     out-of-scope domains, refuses global-mutation tools, and filters
 *     multi-domain reads to the scope list.
 *   - Audit attribution: agent_id is recorded on the audit row in scoped mode.
 *   - Default path (no flags) keeps all 12 tools and does NOT add wrapper-layer
 *     audit rows beyond the pre-refactor baseline (zero regression for the
 *     unscoped single-agent setup).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../server.js";
import { setUserSlug } from "../encryption.js";
import { Ledger } from "../ledger/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-scope-test-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
});

afterEach(() => {
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not found`);
  const result = await tool.handler(args, {});
  return JSON.parse(result.content[0].text);
}

function listTools(server: McpServer): string[] {
  return Object.keys((server as any)._registeredTools);
}

// ---------------------------------------------------------------------------
// Registration-time filtering
// ---------------------------------------------------------------------------

describe("createServer registration filtering", () => {
  it("default opts registers all 12 tools (no regression on unscoped path)", () => {
    const { server, shutdown } = createServer();
    try {
      expect(listTools(server)).toHaveLength(12);
    } finally {
      shutdown();
    }
  });

  it("--readonly drops mutating tools from tools/list", () => {
    const { server, shutdown } = createServer(undefined, { readonly: true });
    try {
      const tools = listTools(server);
      // Mutating tools should be absent
      expect(tools).not.toContain("usrcp_append_event");
      expect(tools).not.toContain("usrcp_update_identity");
      expect(tools).not.toContain("usrcp_update_preferences");
      expect(tools).not.toContain("usrcp_update_domain_context");
      expect(tools).not.toContain("usrcp_manage_project");
      expect(tools).not.toContain("usrcp_set_fact");
      expect(tools).not.toContain("usrcp_rotate_key");
      // Read tools should remain
      expect(tools).toContain("usrcp_get_state");
      expect(tools).toContain("usrcp_search_timeline");
      expect(tools).toContain("usrcp_get_facts");
      expect(tools).toContain("usrcp_status");
      expect(tools).toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });

  it("--no-audit drops usrcp_audit_log from tools/list", () => {
    const { server, shutdown } = createServer(undefined, { noAudit: true });
    try {
      const tools = listTools(server);
      expect(tools).not.toContain("usrcp_audit_log");
      // Other tools should remain
      expect(tools).toContain("usrcp_get_state");
      expect(tools).toContain("usrcp_append_event");
    } finally {
      shutdown();
    }
  });

  it("--readonly + --no-audit composes correctly", () => {
    const { server, shutdown } = createServer(undefined, {
      readonly: true,
      noAudit: true,
    });
    try {
      const tools = listTools(server);
      expect(tools).not.toContain("usrcp_audit_log");
      expect(tools).not.toContain("usrcp_append_event");
      expect(tools).toContain("usrcp_get_state");
      expect(tools).toContain("usrcp_status");
    } finally {
      shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Domain enforcement (--scopes)
// ---------------------------------------------------------------------------

describe("scope enforcement", () => {
  it("rejects domain-scoped tool calls targeting an out-of-scope domain", async () => {
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_append_event", {
        domain: "personal",
        summary: "should be rejected",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(result.status).toBe("out_of_scope");
      expect(result.error).toBe("OUT_OF_SCOPE");
      expect(result.tool).toBe("usrcp_append_event");
      expect(result.requested_domains).toEqual(["personal"]);
      expect(result.allowed_domains).toEqual(["coding"]);
    } finally {
      shutdown();
    }
  });

  it("allows domain-scoped tool calls targeting an in-scope domain", async () => {
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_append_event", {
        domain: "coding",
        summary: "should be accepted",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(result.status).toBe("accepted");
      expect(result.event_id).toBeTruthy();
    } finally {
      shutdown();
    }
  });

  it("refuses global-mutation tools when scopes are set", async () => {
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_update_identity", {
        updates: { name: "new-name" },
      });
      expect(result.status).toBe("out_of_scope");
      expect(result.error).toBe("OUT_OF_SCOPE");
      expect(result.requested_domains).toEqual(["<global>"]);
    } finally {
      shutdown();
    }
  });

  it("rejects multi-domain reads when caller asks for an out-of-scope domain", async () => {
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["personal"],
      });
      expect(result.status).toBe("out_of_scope");
      expect(result.requested_domains).toEqual(["personal"]);
    } finally {
      shutdown();
    }
  });

  it("filters multi-domain reads to the scope list when caller did not specify", async () => {
    // Seed the ledger with events in two domains using an unscoped server.
    const { server: seedServer, shutdown: seedShutdown } = createServer();
    await callTool(seedServer, "usrcp_append_event", {
      domain: "coding",
      summary: "coding-event",
      intent: "test",
      outcome: "success",
      platform: "test",
    });
    await callTool(seedServer, "usrcp_append_event", {
      domain: "personal",
      summary: "personal-event",
      intent: "test",
      outcome: "success",
      platform: "test",
    });
    seedShutdown();

    // Now open a scoped server and ask for the timeline without specifying
    // domains. Scope should be injected.
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
      });
      const timeline = result.state.recent_timeline;
      expect(Array.isArray(timeline)).toBe(true);
      // The personal-event must NOT leak into the coding-scoped read.
      for (const ev of timeline) {
        expect(ev.domain).toBe("coding");
      }
      // And the coding-event must be visible.
      expect(timeline.some((e: any) => e.summary === "coding-event")).toBe(true);
    } finally {
      shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Audit attribution
// ---------------------------------------------------------------------------

describe("audit attribution", () => {
  it("scoped mode records agent_id on every MCP call", async () => {
    const { server, shutdown, ledger } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "cursor-coding",
    });
    try {
      await callTool(server, "usrcp_append_event", {
        domain: "coding",
        summary: "audited",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      const audit = ledger.getAuditLog(50);
      const mcpRows = audit.filter((r: any) => r.operation === "mcp_call:usrcp_append_event");
      expect(mcpRows.length).toBeGreaterThan(0);
      // agent_id is the encrypted column — getAuditLog returns the decrypted view.
      expect(mcpRows[0].agent_id).toBe("cursor-coding");
    } finally {
      shutdown();
    }
  });

  it("default (unscoped) mode does NOT add wrapper-layer mcp_call rows", async () => {
    const { server, shutdown, ledger } = createServer();
    try {
      await callTool(server, "usrcp_append_event", {
        domain: "coding",
        summary: "unscoped",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      const audit = ledger.getAuditLog(50);
      const wrapperRows = audit.filter((r: any) =>
        typeof r.operation === "string" && r.operation.startsWith("mcp_call:")
      );
      expect(wrapperRows).toHaveLength(0);
    } finally {
      shutdown();
    }
  });
});
