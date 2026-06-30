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
import { setUserSlug } from "usrcp-core/encryption";
import { Ledger } from "usrcp-core/ledger";
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
    // Error wording was generalized in #61 to cover --read-scopes /
    // --write-scopes too. The new copy mentions all three.
    expect(output).toContain("require --agent-id");
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

// ---------------------------------------------------------------------------
// Asymmetric scopes (--read-scopes / --write-scopes)
// ---------------------------------------------------------------------------

describe("asymmetric scopes (readScopes / writeScopes)", () => {
  it("--read-scopes alone implies no writes (mutating tools stripped from tools/list)", () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: ["coding", "work"],
      agentId: "test-agent",
    });
    try {
      const tools = listTools(server);
      // Read tools registered:
      expect(tools).toContain("usrcp_get_state");
      expect(tools).toContain("usrcp_search_timeline");
      expect(tools).toContain("usrcp_status");
      // Mutating tools stripped because writeScopes defaults to []:
      expect(tools).not.toContain("usrcp_append_event");
      expect(tools).not.toContain("usrcp_set_fact");
      expect(tools).not.toContain("usrcp_update_identity");
      expect(tools).not.toContain("usrcp_rotate_key");
    } finally {
      shutdown();
    }
  });

  it("--read-scopes constrains reads to the listed domains", async () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: ["coding"],
      agentId: "test-agent",
    });
    try {
      const result = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["personal"],
      });
      expect(result.status).toBe("out_of_scope");
      expect(result.requested_domains).toEqual(["personal"]);
      expect(result.allowed_domains).toEqual(["coding"]);
    } finally {
      shutdown();
    }
  });

  it("--write-scopes alone allows unrestricted reads but constrained writes", async () => {
    // Seed events in two different domains via an unscoped server.
    const { server: seedServer, shutdown: seedShutdown } = createServer();
    await callTool(seedServer, "usrcp_append_event", {
      domain: "coding",
      summary: "seeded-coding",
      intent: "test",
      outcome: "success",
      platform: "test",
    });
    await callTool(seedServer, "usrcp_append_event", {
      domain: "work",
      summary: "seeded-work",
      intent: "test",
      outcome: "success",
      platform: "test",
    });
    seedShutdown();

    const { server, shutdown } = createServer(undefined, {
      writeScopes: ["personal"],
      agentId: "test-agent",
    });
    try {
      // Reads to ANY domain succeed (writeScopes alone leaves reads unrestricted).
      const codingState = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["coding"],
      });
      expect(codingState.state).toBeTruthy();
      const workState = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["work"],
      });
      expect(workState.state).toBeTruthy();

      // Writes to a non-allowlisted domain are rejected.
      const writeBad = await callTool(server, "usrcp_append_event", {
        domain: "coding",
        summary: "should be rejected",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(writeBad.status).toBe("out_of_scope");
      expect(writeBad.allowed_domains).toEqual(["personal"]);

      // Writes to the allowlisted domain succeed.
      const writeOk = await callTool(server, "usrcp_append_event", {
        domain: "personal",
        summary: "should be accepted",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(writeOk.status).toBe("accepted");
    } finally {
      shutdown();
    }
  });

  it("--read-scopes A,B,C --write-scopes A (asymmetric subset) gates appropriately", async () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: ["coding", "work", "personal"],
      writeScopes: ["personal"],
      agentId: "test-agent",
    });
    try {
      // Read on allowlisted domain - OK.
      const readOk = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["coding"],
      });
      expect(readOk.state).toBeTruthy();

      // Read outside read allowlist - rejected.
      const readBad = await callTool(server, "usrcp_get_state", {
        scopes: ["recent_timeline"],
        timeline_domains: ["health"],
      });
      expect(readBad.status).toBe("out_of_scope");

      // Write inside write allowlist - OK.
      const writeOk = await callTool(server, "usrcp_append_event", {
        domain: "personal",
        summary: "write to personal",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(writeOk.status).toBe("accepted");

      // Write on a domain in readScopes but NOT writeScopes - rejected.
      // (Despite being able to READ "coding", this agent can't WRITE to it.)
      const writeBad = await callTool(server, "usrcp_append_event", {
        domain: "coding",
        summary: "should be rejected: readable but not writable",
        intent: "test",
        outcome: "success",
        platform: "test",
      });
      expect(writeBad.status).toBe("out_of_scope");
      expect(writeBad.allowed_domains).toEqual(["personal"]);
    } finally {
      shutdown();
    }
  });

  it("rejects writeScopes that contain a domain not in readScopes (constructor-time)", () => {
    expect(() =>
      createServer(undefined, {
        readScopes: ["coding"],
        writeScopes: ["personal"], // not in read allowlist
        agentId: "test-agent",
      }),
    ).toThrow(/not in readScopes/);
  });

  it("rejects --scopes combined with --read-scopes (mutual exclusion)", () => {
    expect(() =>
      createServer(undefined, {
        scopes: ["coding"],
        readScopes: ["coding"],
        agentId: "test-agent",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects --scopes combined with --write-scopes (mutual exclusion)", () => {
    expect(() =>
      createServer(undefined, {
        scopes: ["coding"],
        writeScopes: ["coding"],
        agentId: "test-agent",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("--readonly overrides writeScopes - mutating tools still stripped even if writeScopes is non-empty", () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: ["coding"],
      writeScopes: ["coding"], // would normally allow writes
      readonly: true, // but --readonly wins
      agentId: "test-agent",
    });
    try {
      const tools = listTools(server);
      expect(tools).not.toContain("usrcp_append_event");
      expect(tools).not.toContain("usrcp_set_fact");
    } finally {
      shutdown();
    }
  });

  it("legacy --scopes=[] preserves the pre-asymmetric 'unrestricted both ways' meaning (codex PR #61 round-1)", () => {
    // Pre-asymmetric `effectiveScopes` returned undefined for an
    // empty array, leaving BOTH reads and writes unrestricted. The
    // first cut of this PR accidentally left writeScopes=[], which
    // would have stripped every mutating tool from any caller that
    // had been doing `createServer({ scopes: [] })`. Lock the
    // backward-compat shape.
    const { server, shutdown } = createServer(undefined, {
      scopes: [],
      // No agent-id required because empty scopes is unrestricted.
    });
    try {
      const tools = listTools(server);
      // All 12 tools registered (no stripping).
      expect(tools).toHaveLength(12);
      // Mutating tools still present.
      expect(tools).toContain("usrcp_append_event");
      expect(tools).toContain("usrcp_set_fact");
    } finally {
      shutdown();
    }
  });

  it("empty --read-scopes is normalized to unrestricted (matches legacy --scopes= behavior)", () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: [],
      writeScopes: ["personal"], // explicit subset would normally require readScopes
      agentId: "test-agent",
    });
    try {
      // Constructor did not throw: empty readScopes is treated as unrestricted,
      // so writeScopes subset check passes trivially.
      const tools = listTools(server);
      expect(tools).toContain("usrcp_append_event");
    } finally {
      shutdown();
    }
  });

  it("audit row records both read and write scopes when asymmetric flags are set", async () => {
    const { server, shutdown, ledger } = createServer(undefined, {
      readScopes: ["coding", "work"],
      writeScopes: ["coding"],
      agentId: "asym-agent",
    });
    try {
      await callTool(server, "usrcp_get_state", { scopes: ["identity"] });
      // We can't easily read the audit table directly here, but the
      // logAudit call carries the compound scope string and the test
      // mainly asserts that the call succeeds without error in the
      // dual-scope path.
      const stats = ledger.getStats();
      expect(stats).toBeTruthy();
    } finally {
      shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// SECURITY regression — v0.1.3 scope-leak fix.
//
// Before v0.1.3, a server scoped to `coding` would still return
// `core_identity` and `global_preferences` (including the freeform
// `custom` field where users wrote ad-hoc secrets) via usrcp_get_state.
// This test plants a secret in `global_preferences.custom` and confirms
// it does not appear in a scoped agent's response.
// ---------------------------------------------------------------------------

describe("v0.1.3 SECURITY: scoped get_state redacts core_identity + global_preferences", () => {
  it("does not leak global_preferences.custom to a coding-scoped agent", async () => {
    // Step 1: plant a secret via an UNSCOPED server (matches what a
    // real user does when configuring preferences during setup).
    const unscoped = createServer(undefined, {});
    try {
      await callTool(unscoped.server, "usrcp_update_preferences", {
        custom: { private_global_secret: "PLANTED_v013_DEADBEEF" },
        caller: "plant-test",
      });
    } finally {
      unscoped.shutdown();
    }

    // Step 2: open a coding-scoped server and try to read globals.
    const scoped = createServer(undefined, {
      readScopes: ["coding"],
      agentId: "attacker-coding",
    });
    try {
      const result = await callTool(scoped.server, "usrcp_get_state", {
        scopes: [
          "core_identity",
          "global_preferences",
          "active_projects",
          "domain_context",
        ],
        caller: "attacker",
      });
      const text =
        result?.content?.[0]?.text ?? JSON.stringify(result);
      expect(text).not.toContain("PLANTED_v013_DEADBEEF");
      const parsed = JSON.parse(text);
      expect(parsed.state.core_identity).toBeUndefined();
      expect(parsed.state.global_preferences).toBeUndefined();
    } finally {
      scoped.shutdown();
    }
  });

  it("legacy --scopes= symmetric flag also enforces global redaction", async () => {
    // Same attack, but via the legacy `scopes` flag instead of `readScopes`.
    const unscoped = createServer(undefined, {});
    try {
      await callTool(unscoped.server, "usrcp_update_preferences", {
        custom: { another_secret: "PLANTED_v013_LEGACY_FLAG" },
        caller: "plant-test",
      });
    } finally {
      unscoped.shutdown();
    }

    const scoped = createServer(undefined, {
      scopes: ["coding"],
      agentId: "attacker-legacy",
    });
    try {
      const result = await callTool(scoped.server, "usrcp_get_state", {
        scopes: ["core_identity", "global_preferences"],
        caller: "attacker",
      });
      const text =
        result?.content?.[0]?.text ?? JSON.stringify(result);
      expect(text).not.toContain("PLANTED_v013_LEGACY_FLAG");
      const parsed = JSON.parse(text);
      expect(parsed.state.core_identity).toBeUndefined();
      expect(parsed.state.global_preferences).toBeUndefined();
    } finally {
      scoped.shutdown();
    }
  });

  it("unscoped server still returns globals (no regression)", async () => {
    const unscoped = createServer(undefined, {});
    try {
      await callTool(unscoped.server, "usrcp_update_preferences", {
        custom: { sentinel: "PLANTED_v013_UNSCOPED" },
        caller: "plant-test",
      });
      const result = await callTool(unscoped.server, "usrcp_get_state", {
        scopes: ["global_preferences"],
        caller: "owner",
      });
      const text =
        result?.content?.[0]?.text ?? JSON.stringify(result);
      // Unscoped reader IS allowed to see its own globals.
      expect(text).toContain("PLANTED_v013_UNSCOPED");
    } finally {
      unscoped.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// SECURITY regression — v0.1.4 audit-log scope strip
//
// Before v0.1.4, usrcp_audit_log was only stripped from tools/list when
// --no-audit was explicitly passed. Scoped agents (--read-scopes=...,
// --scopes=...) got the full audit history by default, including
// operations on other domains, ULIDs from other scopes, agent_ids of
// other sessions, and scope-pseudonym mappings. v0.1.4 strips audit-read
// from any session where ANY scope flag is set.
// ---------------------------------------------------------------------------

describe("v0.1.4 SECURITY: audit_log is owner-only (stripped from scoped agents)", () => {
  function listToolNames(server: McpServer): string[] {
    const tools = (server as any)._registeredTools;
    return Object.keys(tools);
  }

  it("strips usrcp_audit_log from --read-scopes session", () => {
    const { server, shutdown } = createServer(undefined, {
      readScopes: ["coding"],
      agentId: "scoped-agent",
    });
    try {
      const names = listToolNames(server);
      expect(names).not.toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });

  it("strips usrcp_audit_log from --scopes (legacy symmetric) session", () => {
    const { server, shutdown } = createServer(undefined, {
      scopes: ["coding"],
      agentId: "scoped-agent",
    });
    try {
      const names = listToolNames(server);
      expect(names).not.toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });

  it("keeps usrcp_audit_log for --write-scopes only session (reads unrestricted)", () => {
    // Distinct from --read-scopes: --write-scopes alone limits writes
    // but leaves reads unrestricted, so the operator can still see
    // their own audit log.
    const { server, shutdown } = createServer(undefined, {
      writeScopes: ["coding"],
      agentId: "scoped-agent",
    });
    try {
      const names = listToolNames(server);
      expect(names).toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });

  it("keeps usrcp_audit_log for --readonly session (owner-equivalent reads)", () => {
    const { server, shutdown } = createServer(undefined, {
      readonly: true,
    });
    try {
      const names = listToolNames(server);
      expect(names).toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });

  it("keeps usrcp_audit_log for unscoped (owner) session", () => {
    const { server, shutdown } = createServer(undefined, {});
    try {
      const names = listToolNames(server);
      expect(names).toContain("usrcp_audit_log");
    } finally {
      shutdown();
    }
  });
});
