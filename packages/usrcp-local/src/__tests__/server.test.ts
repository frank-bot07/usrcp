import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../server.js";
import { initializeIdentity } from "../crypto.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let server: McpServer;
let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-test-server-"));
  process.env.HOME = tmpHome;

  initializeIdentity();
  const created = createServer();
  server = created.server;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Helper to call an MCP tool by accessing internal handler
async function callTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not found`);

  const result = await tool.handler(args, {});
  const text = result.content[0].text;
  return JSON.parse(text);
}

describe("Server creation", () => {
  it("creates a server with 8 tools", () => {
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });

  it("registers all expected tools", () => {
    const tools = Object.keys((server as any)._registeredTools);
    expect(tools).toContain("usrcp_get_state");
    expect(tools).toContain("usrcp_append_event");
    expect(tools).toContain("usrcp_update_identity");
    expect(tools).toContain("usrcp_update_preferences");
    expect(tools).toContain("usrcp_update_domain_context");
    expect(tools).toContain("usrcp_search_timeline");
    expect(tools).toContain("usrcp_manage_project");
    expect(tools).toContain("usrcp_status");
  });
});

describe("usrcp_get_state", () => {
  it("returns state with all default scopes", async () => {
    const result = await callTool("usrcp_get_state", {
      scopes: [
        "core_identity",
        "global_preferences",
        "recent_timeline",
        "domain_context",
        "active_projects",
      ],
    });
    expect(result.usrcp_version).toBe("0.1.0");
    expect(result.user_id).toMatch(/^usrcp:\/\/local\//);
    expect(result.resolved_at).toBeTruthy();
    expect(result.cache_hint).toBeDefined();
    expect(result.cache_hint.ttl_seconds).toBe(300);
    expect(result.cache_hint.etag).toMatch(/^W\//);
    expect(result.state.core_identity).toBeDefined();
    expect(result.state.global_preferences).toBeDefined();
    expect(result.state.recent_timeline).toBeDefined();
    expect(result.state.domain_context).toBeDefined();
    expect(result.state.active_projects).toBeDefined();
  });

  it("returns only requested scopes", async () => {
    const result = await callTool("usrcp_get_state", {
      scopes: ["core_identity"],
    });
    expect(result.state.core_identity).toBeDefined();
    expect(result.state.global_preferences).toBeUndefined();
  });
});

describe("usrcp_append_event", () => {
  it("appends an event and returns accepted status", async () => {
    const result = await callTool("usrcp_append_event", {
      domain: "coding",
      summary: "Built test suite",
      intent: "Add test coverage",
      outcome: "success",
      platform: "claude_code",
    });
    expect(result.usrcp_version).toBe("0.1.0");
    expect(result.status).toBe("accepted");
    expect(result.event_id).toBeTruthy();
    expect(result.ledger_sequence).toBe(1);
  });

  it("handles idempotency key", async () => {
    const r1 = await callTool("usrcp_append_event", {
      domain: "coding",
      summary: "e1",
      intent: "i1",
      outcome: "success",
      platform: "test",
      idempotency_key: "idem_test",
    });
    const r2 = await callTool("usrcp_append_event", {
      domain: "coding",
      summary: "e2",
      intent: "i2",
      outcome: "success",
      platform: "test",
      idempotency_key: "idem_test",
    });
    expect(r1.event_id).toBe(r2.event_id);
    expect(r2.status).toBe("duplicate");
  });
});

describe("usrcp_update_identity", () => {
  it("updates and returns identity", async () => {
    const result = await callTool("usrcp_update_identity", {
      display_name: "Frank",
      roles: ["founder"],
    });
    expect(result.status).toBe("updated");
    expect(result.core_identity.display_name).toBe("Frank");
    expect(result.core_identity.roles).toEqual(["founder"]);
  });
});

describe("usrcp_update_preferences", () => {
  it("updates and returns preferences", async () => {
    const result = await callTool("usrcp_update_preferences", {
      timezone: "America/Los_Angeles",
      verbosity: "minimal",
    });
    expect(result.status).toBe("updated");
    expect(result.global_preferences.timezone).toBe("America/Los_Angeles");
    expect(result.global_preferences.verbosity).toBe("minimal");
  });
});

describe("usrcp_update_domain_context", () => {
  it("stores and returns domain context", async () => {
    const result = await callTool("usrcp_update_domain_context", {
      domain: "coding",
      context: { framework: "nextjs", css: "tailwind" },
    });
    expect(result.status).toBe("updated");
    expect(result.domain).toBe("coding");
    expect(result.context.framework).toBe("nextjs");
  });

  it("merges context on subsequent calls", async () => {
    await callTool("usrcp_update_domain_context", {
      domain: "coding",
      context: { framework: "nextjs" },
    });
    const result = await callTool("usrcp_update_domain_context", {
      domain: "coding",
      context: { css: "tailwind" },
    });
    expect(result.context.framework).toBe("nextjs");
    expect(result.context.css).toBe("tailwind");
  });
});

describe("usrcp_search_timeline", () => {
  it("finds events by keyword", async () => {
    await callTool("usrcp_append_event", {
      domain: "coding",
      summary: "Fixed authentication middleware",
      intent: "Fix auth",
      outcome: "success",
      platform: "test",
    });
    const result = await callTool("usrcp_search_timeline", {
      query: "authentication",
    });
    expect(result.result_count).toBe(1);
    expect(result.events[0].summary).toContain("authentication");
  });
});

describe("usrcp_manage_project", () => {
  it("creates a project", async () => {
    const result = await callTool("usrcp_manage_project", {
      project_id: "usrcp",
      name: "USRCP",
      domain: "coding",
      status: "active",
      summary: "Building the protocol",
    });
    expect(result.status).toBe("updated");
    expect(result.project.name).toBe("USRCP");
  });
});

describe("usrcp_status", () => {
  it("returns ledger stats", async () => {
    const result = await callTool("usrcp_status", {});
    expect(result.usrcp_version).toBe("0.1.0");
    expect(result.user_id).toMatch(/^usrcp:\/\/local\//);
    expect(result.ledger).toBe("local (SQLite)");
    expect(result.stats.total_events).toBe(0);
  });
});
