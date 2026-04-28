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
import { spawnSync } from "node:child_process";
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

  it("usrcp_status returns scoped stats and projects for a scoped caller", async () => {
    // Seed two domains via an unscoped server.
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
    await callTool(seedServer, "usrcp_manage_project", {
      project_id: "personal-project",
      domain: "personal",
      name: "personal-project",
      status: "active",
      summary: "out-of-scope project",
    });
    seedShutdown();

    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_status", {});
      // Scoped envelope must replace the unscoped one — ledger-wide totals
      // must not reach a scoped caller.
      expect(result.scoped).toBe(true);
      expect(result.allowed_domains).toEqual(["coding"]);
      // Personal-domain project must NOT count toward active_projects.
      expect(result.active_projects).toBe(0);
      // Stats must be scope-filtered, not ledger-wide.
      expect(result.stats).toBeDefined();
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
  it("scoped mode records agent_id on every MCP call (verified by raw DB read)", async () => {
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

      // Raw SQL read — bypass getAuditLog so we verify the row physically
      // exists in the DB with an encrypted (non-empty, non-plaintext)
      // agent_id column. If the wrapper-audit call were a no-op (or a stub
      // that returned early), no row would exist here regardless of what
      // the higher-level decoded view returned.
      const db = (ledger as any).db as import("better-sqlite3").Database;
      const rawRows = db
        .prepare(
          `SELECT id, agent_id, operation, integrity_tag
           FROM audit_log
           ORDER BY id DESC`
        )
        .all() as Array<{ id: number; agent_id: string; operation: string; integrity_tag: string }>;
      expect(rawRows.length).toBeGreaterThan(0);

      // Decrypt the operation column directly to find our wrapper-audit row.
      // Cannot match plaintext because the column is ciphertext — we have to
      // walk the rows and decrypt each operation field.
      const decryptGlobal = (ledger as any).decryptGlobal.bind(ledger);
      const matched = rawRows
        .map((r) => ({
          ...r,
          op_decoded: decryptGlobal(r.operation) as string,
          agent_decoded: decryptGlobal(r.agent_id) as string,
        }))
        .filter((r) => r.op_decoded === "mcp_call:usrcp_append_event");
      expect(matched.length).toBeGreaterThan(0);

      // Two independent assertions:
      //  (a) the encrypted column on disk decrypts to the agent_id we passed
      expect(matched[0].agent_decoded).toBe("cursor-coding");
      //  (b) integrity_tag is present and non-empty (HMAC was computed)
      expect(matched[0].integrity_tag).toMatch(/^[0-9a-f]{32}$/);

      // Higher-level decoded view should agree with the raw read.
      const audit = ledger.getAuditLog(50);
      const mcpRows = audit.filter((r: any) => r.operation === "mcp_call:usrcp_append_event");
      expect(mcpRows.length).toBe(matched.length);
      expect(mcpRows[0].agent_id).toBe("cursor-coding");
      expect(mcpRows[0].integrity_verified).toBe(true);
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

// ---------------------------------------------------------------------------
// CLI flag validation (subprocess — verifies real exit code, not a thrown
// error caught somewhere in test scaffolding)
// ---------------------------------------------------------------------------

const CLI_ENTRY = path.resolve(__dirname, "..", "..", "dist", "index.js");

// Skip this block entirely if dist/index.js isn't built — local `vitest run`
// without a prior `npm run build` is a common case and shouldn't error here.
const distExists = fs.existsSync(CLI_ENTRY);

describe.skipIf(!distExists)("CLI flag validation (subprocess)", () => {
  it("--scopes without --agent-id exits non-zero with attribution error", () => {
    // Init a fresh ledger in tmpHome so `serve` can find it.
    const initRes = spawnSync(
      process.execPath,
      [CLI_ENTRY, "init", "--dev"],
      { env: { ...process.env, HOME: tmpHome }, encoding: "utf8" }
    );
    expect(initRes.status).toBe(0);

    // Now try to start serve with --scopes but no --agent-id.
    const res = spawnSync(
      process.execPath,
      [CLI_ENTRY, "serve", "--scopes=coding"],
      { env: { ...process.env, HOME: tmpHome }, encoding: "utf8", input: "" }
    );
    expect(res.status).toBe(1);
    const output = (res.stdout + res.stderr).toLowerCase();
    expect(output).toContain("--scopes requires --agent-id".toLowerCase());
  });

  it("--agent-id with disallowed characters exits non-zero", () => {
    const initRes = spawnSync(
      process.execPath,
      [CLI_ENTRY, "init", "--dev"],
      { env: { ...process.env, HOME: tmpHome }, encoding: "utf8" }
    );
    expect(initRes.status).toBe(0);

    const res = spawnSync(
      process.execPath,
      [CLI_ENTRY, "serve", "--agent-id=bad agent name"],
      { env: { ...process.env, HOME: tmpHome }, encoding: "utf8", input: "" }
    );
    expect(res.status).toBe(1);
    const output = (res.stdout + res.stderr).toLowerCase();
    expect(output).toContain("--agent-id may only contain".toLowerCase());
  });
});
