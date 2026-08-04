import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "../server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ledger } from "usrcp-core/ledger";

/**
 * Regression for #175 at the MCP handler path: the ordinary
 * `usrcp_get_state` recent_timeline read must be attributed to the caller
 * (never "system") AND must read the timeline exactly once.
 *
 * The bug had two layers:
 *   - Ledger.getState read recent_timeline via getTimeline({ last_n: 50 })
 *     with no agentId, so the audit row was attributed to "system".
 *   - When the handler was given a timeline filter, it re-read the timeline a
 *     second time (attributed to the caller), so a filtered get_state produced
 *     TWO get_timeline audit rows -- one "system" default, one caller filtered.
 *
 * The fix threads the caller and any filter INTO getState, so exactly one
 * timeline read happens, attributed to the caller. We drive the real wrapped
 * MCP handler and inspect the ledger audit log.
 */
let server: McpServer;
let ledger: Ledger;
let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-getstate-attr-"));
  process.env.HOME = tmpHome;
  const created = createServer();
  server = created.server;
  ledger = created.ledger;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function callTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not found`);
  const result = await tool.handler(args, {});
  return JSON.parse(result.content[0].text);
}

describe("usrcp_get_state timeline attribution (#175)", () => {
  it("reads the timeline once, attributed to the caller, when a filter is given", async () => {
    ledger.appendEvent(
      { domain: "coding", summary: "auth fix", intent: "i", outcome: "success" },
      "test"
    );

    await callTool("usrcp_get_state", {
      scopes: ["recent_timeline"],
      timeline_last_n: 1,
      caller: "cursor",
    });

    const log = ledger.getAuditLog();
    const timelineReads = log.filter((e: any) => e.operation === "get_timeline");
    // Pre-fix: two reads (a "system" default + a "cursor" filtered).
    expect(timelineReads).toHaveLength(1);
    expect(timelineReads[0].agent_id).toBe("cursor");
    expect(timelineReads.some((e: any) => e.agent_id === "system")).toBe(false);

    const getStateReads = log.filter((e: any) => e.operation === "get_state");
    expect(getStateReads).toHaveLength(1);
    expect(getStateReads[0].agent_id).toBe("cursor");
  });

  it("attributes the default (unfiltered) recent_timeline read to the caller", async () => {
    ledger.appendEvent(
      { domain: "coding", summary: "auth fix", intent: "i", outcome: "success" },
      "test"
    );

    await callTool("usrcp_get_state", {
      scopes: ["recent_timeline"],
      caller: "cursor",
    });

    const timelineReads = ledger
      .getAuditLog()
      .filter((e: any) => e.operation === "get_timeline");
    // Pre-fix: the single default read was logged as "system".
    expect(timelineReads).toHaveLength(1);
    expect(timelineReads[0].agent_id).toBe("cursor");
  });
});
