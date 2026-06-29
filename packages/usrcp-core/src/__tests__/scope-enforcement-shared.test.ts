/**
 * Tests for the shared scope-enforcement module (PR #64). The
 * resolveScopes / registerToolsWithScopes / outOfScopeResponse logic
 * used to live in two places (usrcp-local/src/server.ts and
 * usrcp-stream/src/register.ts) and drifted across four codex review
 * rounds on PR #61. The shared module is the single source of truth;
 * both packages import from here.
 *
 * The existing scope-enforcement.test.ts covers behavior end-to-end
 * via createServer. This file covers the SHARED MODULE directly:
 * tests are written against the lifted helpers without going through
 * a real MCP server, so they pin the contract independent of the
 * caller wiring.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ScopedToolDef,
  type ServeOptions,
  outOfScopeResponse,
  registerToolsWithScopes,
  resolveScopes,
  projectStateResult,
  projectSearchResult,
  buildScopedStatusPayload,
  filterEventsToScopes,
} from "../scope-enforcement.js";

describe("resolveScopes (shared) - core contract", () => {
  it("legacy --scopes maps to symmetric read+write", () => {
    const { readScopes, writeScopes } = resolveScopes({ scopes: ["coding"] });
    expect(readScopes).toEqual(["coding"]);
    expect(writeScopes).toEqual(["coding"]);
  });

  it("--read-scopes alone defaults writeScopes to [] (no writes)", () => {
    const { readScopes, writeScopes } = resolveScopes({ readScopes: ["coding"] });
    expect(readScopes).toEqual(["coding"]);
    expect(writeScopes).toEqual([]);
  });

  it("--write-scopes alone leaves reads unrestricted", () => {
    const { readScopes, writeScopes } = resolveScopes({ writeScopes: ["coding"] });
    expect(readScopes).toBeUndefined();
    expect(writeScopes).toEqual(["coding"]);
  });

  it("--readonly forces writeScopes to []", () => {
    const { writeScopes } = resolveScopes({ readonly: true });
    expect(writeScopes).toEqual([]);
  });

  it("--readonly wins over an explicit writeScopes allowlist", () => {
    const { writeScopes } = resolveScopes({
      readScopes: ["coding"],
      writeScopes: ["coding"],
      readonly: true,
    });
    expect(writeScopes).toEqual([]);
  });

  it("legacy --scopes empty array normalizes to unrestricted-both-ways (pre-asymmetric semantics)", () => {
    const { readScopes, writeScopes } = resolveScopes({ scopes: [] });
    expect(readScopes).toBeUndefined();
    expect(writeScopes).toBeUndefined();
  });

  it("--scopes is mutually exclusive with --read-scopes / --write-scopes", () => {
    expect(() => resolveScopes({ scopes: ["a"], readScopes: ["a"] })).toThrow(
      /mutually exclusive/,
    );
    expect(() => resolveScopes({ scopes: ["a"], writeScopes: ["a"] })).toThrow(
      /mutually exclusive/,
    );
  });

  it("writeScopes ⊆ readScopes is required when both are non-empty allowlists", () => {
    expect(() =>
      resolveScopes({ readScopes: ["coding"], writeScopes: ["personal"] }),
    ).toThrow(/not in readScopes/);
  });

  it("empty writeScopes is trivially a subset (no error even though readScopes is restrictive)", () => {
    expect(() =>
      resolveScopes({ readScopes: ["coding"], writeScopes: [] }),
    ).not.toThrow();
  });
});

describe("outOfScopeResponse (shared) - identical envelope from both packages", () => {
  it("returns the documented JSON shape with status/error/tool/requested/allowed", () => {
    const res = outOfScopeResponse("usrcp_append_event", ["personal"], ["coding"]);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("out_of_scope");
    expect(body.error).toBe("OUT_OF_SCOPE");
    expect(body.tool).toBe("usrcp_append_event");
    expect(body.requested_domains).toEqual(["personal"]);
    expect(body.allowed_domains).toEqual(["coding"]);
    expect(body.message).toContain("[personal]");
    expect(body.message).toContain("[coding]");
  });
});

describe("registerToolsWithScopes (shared) - direct wrapper exercise", () => {
  function makeFakeServer(): {
    server: McpServer;
    registered: Record<string, { handler: (p: any) => Promise<any> }>;
  } {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    return {
      server,
      registered: (server as any)._registeredTools,
    };
  }

  function makeDef(
    overrides: Partial<ScopedToolDef> = {},
  ): ScopedToolDef {
    return {
      name: "t_test",
      description: "test tool",
      inputShape: { domain: z.string() },
      handler: async (params) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...params }) }],
      }),
      mutating: false,
      kind: "domain-scoped",
      scopeOf: (p) => [String(p.domain)],
      ...overrides,
    };
  }

  it("strips mutating tools at registration time when writes are all-denied (--readonly)", () => {
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [
        makeDef({ name: "t_read", mutating: false }),
        makeDef({ name: "t_write", mutating: true }),
      ],
      { readonly: true } as ServeOptions,
      null,
    );
    expect(Object.keys(registered).sort()).toEqual(["t_read"]);
  });

  it("strips audit-read tools when noAudit is set", () => {
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [
        makeDef({ name: "t_audit", kind: "audit-read", mutating: false }),
        makeDef({ name: "t_read", kind: "global-read", mutating: false }),
      ],
      { noAudit: true } as ServeOptions,
      null,
    );
    expect(Object.keys(registered).sort()).toEqual(["t_read"]);
  });

  it("rejects domain-scoped tools targeting an out-of-scope domain (per-call wrapper)", async () => {
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [makeDef({ name: "t_domain", mutating: true })],
      { readScopes: ["coding"], writeScopes: ["coding"] } as ServeOptions,
      null,
    );
    const result = await registered["t_domain"].handler({ domain: "personal" }, {});
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe("out_of_scope");
    expect(body.allowed_domains).toEqual(["coding"]);
  });

  it("allows domain-scoped tools targeting an in-scope domain", async () => {
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [makeDef({ name: "t_domain", mutating: true })],
      { readScopes: ["coding"], writeScopes: ["coding"] } as ServeOptions,
      null,
    );
    const result = await registered["t_domain"].handler({ domain: "coding" }, {});
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(true);
  });

  it("refuses global-mutation tools when writeScopes is restrictive", async () => {
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [
        makeDef({
          name: "t_global_mut",
          kind: "global-mutation",
          mutating: true,
          scopeOf: undefined,
        }),
      ],
      { writeScopes: ["coding"] } as ServeOptions,
      null,
    );
    const result = await registered["t_global_mut"].handler({}, {});
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe("out_of_scope");
    expect(body.requested_domains).toEqual(["<global>"]);
  });

  it("strictAudit default = audit failures throw out before handler runs (codex PR #64 round-1)", async () => {
    // usrcp-local's pre-#64 contract: in scoped mode, every tool
    // call must produce an audit row before the handler runs. If
    // the audit write throws (DB / encryption / table corruption),
    // the call MUST fail closed - an unattributed proceed silently
    // violates the scoped-mode security property.
    const { server, registered } = makeFakeServer();
    const calls: string[] = [];
    const failingLedger = {
      logAudit() {
        throw new Error("simulated audit-table failure");
      },
    };
    registerToolsWithScopes(
      server,
      [
        makeDef({
          name: "t_strict",
          mutating: false,
          handler: async () => {
            calls.push("handler-ran");
            return { content: [{ type: "text" as const, text: "{}" }] };
          },
        }),
      ],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      failingLedger,
      // strictAudit defaults to true.
    );
    await expect(
      registered["t_strict"].handler({ domain: "coding" }, {}),
    ).rejects.toThrow(/simulated audit-table failure/);
    expect(calls).toEqual([]);
  });

  it("strictAudit: false = audit failures are swallowed and the handler still runs (stream behavior)", async () => {
    // usrcp-stream's pre-#64 trade-off: a cross-package audit
    // failure must not crater the stream tool. Stream call sites
    // opt into best-effort with strictAudit: false.
    const { server, registered } = makeFakeServer();
    const calls: string[] = [];
    const failingLedger = {
      logAudit() {
        throw new Error("simulated audit-table failure");
      },
    };
    // Silence the new default-onAuditFailure warn for this assertion
    // (we test the warn behavior below).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerToolsWithScopes(
      server,
      [
        makeDef({
          name: "t_loose",
          mutating: false,
          handler: async () => {
            calls.push("handler-ran");
            return { content: [{ type: "text" as const, text: "{}" }] };
          },
        }),
      ],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      failingLedger,
      { strictAudit: false },
    );
    const result = await registered["t_loose"].handler({ domain: "coding" }, {});
    expect(result.content[0].text).toBe("{}");
    expect(calls).toEqual(["handler-ran"]);
    warnSpy.mockRestore();
  });

  // --- Codex Tier-2 #4: best-effort audit failures must leave a breadcrumb ---

  it("strictAudit:false emits a console.warn by default when logAudit throws", async () => {
    const { server, registered } = makeFakeServer();
    const failingLedger = {
      logAudit() {
        throw new Error("disk full");
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerToolsWithScopes(
      server,
      [makeDef({ name: "t_warn", mutating: false })],
      { readScopes: ["coding"], agentId: "agent-alice" } as ServeOptions,
      failingLedger,
      { strictAudit: false },
    );
    await registered["t_warn"].handler({ domain: "coding" }, {});

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("tool=t_warn");
    expect(msg).toContain("agent=agent-alice");
    expect(msg).toContain("read=[coding]");
    expect(msg).toContain("disk full");
    expect(msg).toContain("strictAudit:false");
    warnSpy.mockRestore();
  });

  it("strictAudit:false routes audit failures through a caller-supplied onAuditFailure", async () => {
    const { server, registered } = makeFakeServer();
    const captured: Array<{ msg: string; ctx: any }> = [];
    const failingLedger = {
      logAudit() {
        throw new Error("simulated logAudit failure");
      },
    };
    registerToolsWithScopes(
      server,
      [makeDef({ name: "t_callback", mutating: false })],
      { readScopes: ["coding"], agentId: "agent-bob" } as ServeOptions,
      failingLedger,
      {
        strictAudit: false,
        onAuditFailure: (err, ctx) => {
          captured.push({ msg: err instanceof Error ? err.message : String(err), ctx });
        },
      },
    );
    await registered["t_callback"].handler({ domain: "coding" }, {});

    expect(captured).toHaveLength(1);
    expect(captured[0].msg).toBe("simulated logAudit failure");
    expect(captured[0].ctx).toMatchObject({
      toolName: "t_callback",
      agentId: "agent-bob",
    });
    expect(captured[0].ctx.scopeRepr).toContain("read=[coding]");
  });

  it("strictAudit:false tolerates an onAuditFailure that itself throws (handler still runs)", async () => {
    const { server, registered } = makeFakeServer();
    const calls: string[] = [];
    const failingLedger = {
      logAudit() {
        throw new Error("primary audit failure");
      },
    };
    registerToolsWithScopes(
      server,
      [
        makeDef({
          name: "t_double_fail",
          mutating: false,
          handler: async () => {
            calls.push("handler-ran");
            return { content: [{ type: "text" as const, text: "{}" }] };
          },
        }),
      ],
      { readScopes: ["coding"], agentId: "agent-c" } as ServeOptions,
      failingLedger,
      {
        strictAudit: false,
        onAuditFailure: () => {
          throw new Error("callback itself blew up");
        },
      },
    );
    const result = await registered["t_double_fail"].handler({ domain: "coding" }, {});
    expect(result.content[0].text).toBe("{}");
    expect(calls).toEqual(["handler-ran"]);
  });

  it("strictAudit (default) does NOT invoke onAuditFailure - errors propagate verbatim", async () => {
    // The callback is irrelevant in strict mode: a logAudit throw
    // takes the call down before any handler or callback runs.
    const { server, registered } = makeFakeServer();
    const callbackCalls: number[] = [];
    const failingLedger = {
      logAudit() {
        throw new Error("strict audit failure");
      },
    };
    registerToolsWithScopes(
      server,
      [makeDef({ name: "t_strict_cb", mutating: false })],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      failingLedger,
      {
        // strictAudit defaults to true; the callback should be ignored.
        onAuditFailure: () => {
          callbackCalls.push(1);
        },
      },
    );
    await expect(
      registered["t_strict_cb"].handler({ domain: "coding" }, {}),
    ).rejects.toThrow(/strict audit failure/);
    expect(callbackCalls).toEqual([]);
  });

  it("write-tools check writeScopes; read-tools check readScopes (asymmetric routing)", async () => {
    // Read scope = coding+work, write scope = coding. A read on
    // "work" succeeds (in read allowlist); a write to "work" fails
    // (not in write allowlist).
    const { server, registered } = makeFakeServer();
    registerToolsWithScopes(
      server,
      [
        makeDef({ name: "t_read", mutating: false }),
        makeDef({ name: "t_write", mutating: true }),
      ],
      { readScopes: ["coding", "work"], writeScopes: ["coding"] } as ServeOptions,
      null,
    );

    const okRead = JSON.parse(
      (await registered["t_read"].handler({ domain: "work" }, {})).content[0].text,
    );
    expect(okRead.ok).toBe(true);

    const failWrite = JSON.parse(
      (await registered["t_write"].handler({ domain: "work" }, {})).content[0].text,
    );
    expect(failWrite.status).toBe("out_of_scope");
    expect(failWrite.allowed_domains).toEqual(["coding"]);
  });
});

// ---------------------------------------------------------------------------
// v0.1.8 — central default-deny read projection
//
// Before v0.1.8 a multi-domain-read tool whose scopeOf returned "all" was
// trusted to self-filter its output inside its own handler closure. The
// wrapper enforced nothing on the output, so a read tool that forgot to
// redact a facet leaked cross-domain data silently (the v0.1.3 globals
// leak and the v0.1.4 audit-log leak were both this shape). The wrapper
// now (a) REFUSES to register a cross-domain read tool that declares no
// readProjection when reads are scoped, and (b) applies the declared
// projection centrally to every cross-domain read's output. These tests
// pin both halves of that contract.
// ---------------------------------------------------------------------------

describe("default-deny registration invariant (v0.1.8)", () => {
  function makeServer(): {
    server: McpServer;
    registered: Record<string, { handler: (p: any) => Promise<any> }>;
  } {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    return { server, registered: (server as any)._registeredTools };
  }

  const crossDomainNoProjection: ScopedToolDef = {
    name: "t_leaky_read",
    description: "a cross-domain read that forgot to declare a projection",
    inputShape: {},
    handler: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
    mutating: false,
    kind: "multi-domain-read",
    scopeOf: () => "all",
    // readProjection intentionally omitted — this is the bug class.
  };

  it("refuses to register a multi-domain-read tool with no readProjection when reads are scoped", () => {
    const { server } = makeServer();
    expect(() =>
      registerToolsWithScopes(
        server,
        [crossDomainNoProjection],
        { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
        null,
      ),
    ).toThrow(/t_leaky_read.*readProjection/s);
  });

  it("refuses to register a global-read tool with no readProjection when reads are scoped", () => {
    const { server } = makeServer();
    expect(() =>
      registerToolsWithScopes(
        server,
        [{ ...crossDomainNoProjection, name: "t_leaky_global", kind: "global-read", scopeOf: undefined }],
        { scopes: ["coding"], agentId: "a1" } as ServeOptions,
        null,
      ),
    ).toThrow(/t_leaky_global.*readProjection/s);
  });

  it("allows the same tool when reads are UNscoped (owner sees everything; nothing to project)", () => {
    const { server, registered } = makeServer();
    // --write-scopes only leaves reads unrestricted → readScopes undefined.
    registerToolsWithScopes(
      server,
      [crossDomainNoProjection],
      { writeScopes: ["coding"], agentId: "a1" } as ServeOptions,
      null,
    );
    expect(Object.keys(registered)).toContain("t_leaky_read");
  });

  it("allows a cross-domain read tool that DOES declare a readProjection under a read scope", () => {
    const { server, registered } = makeServer();
    registerToolsWithScopes(
      server,
      [{ ...crossDomainNoProjection, readProjection: (p) => p }],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      null,
    );
    expect(Object.keys(registered)).toContain("t_leaky_read");
  });

  it("domain-scoped reads do NOT require a projection (gated at the input layer)", () => {
    const { server, registered } = makeServer();
    registerToolsWithScopes(
      server,
      [
        {
          name: "t_domain_read",
          description: "domain-scoped read",
          inputShape: { domain: z.string() },
          handler: async () => ({ content: [{ type: "text" as const, text: "{}" }] }),
          mutating: false,
          kind: "domain-scoped",
          scopeOf: (p) => [String(p.domain)],
        },
      ],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      null,
    );
    expect(Object.keys(registered)).toContain("t_domain_read");
  });
});

describe("central projection application (v0.1.8)", () => {
  function makeServer(): {
    server: McpServer;
    registered: Record<string, { handler: (p: any) => Promise<any> }>;
  } {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    return { server, registered: (server as any)._registeredTools };
  }

  const def = (readProjection: ScopedToolDef["readProjection"]): ScopedToolDef => ({
    name: "t_proj",
    description: "projected read",
    inputShape: {},
    // Handler returns a RAW payload (not an envelope) — the wrapper serializes.
    handler: async () => ({ secret: "GLOBAL", events: [{ domain: "coding" }, { domain: "personal" }] }),
    mutating: false,
    kind: "multi-domain-read",
    scopeOf: () => "all",
    readProjection,
  });

  it("applies the projection to handler output and serializes it when read-scoped", async () => {
    const { server, registered } = makeServer();
    registerToolsWithScopes(
      server,
      [def((payload, rs) => filterEventsToScopes(payload.events, rs))],
      { readScopes: ["coding"], agentId: "a1" } as ServeOptions,
      { logAudit() {} },
    );
    const out = JSON.parse((await registered["t_proj"].handler({}, {})).content[0].text);
    // Projection returned only the in-scope events; the global secret is gone.
    expect(out).toEqual([{ domain: "coding" }]);
  });

  it("serializes the raw payload WITHOUT projecting when unscoped (--write-scopes only)", async () => {
    const { server, registered } = makeServer();
    const proj = vi.fn((payload) => payload);
    registerToolsWithScopes(
      server,
      [def(proj)],
      { writeScopes: ["coding"], agentId: "a1" } as ServeOptions,
      { logAudit() {} },
    );
    const out = JSON.parse((await registered["t_proj"].handler({}, {})).content[0].text);
    // Owner (unscoped reads) sees the full payload; projection not invoked.
    expect(proj).not.toHaveBeenCalled();
    expect(out.secret).toBe("GLOBAL");
    expect(out.events).toHaveLength(2);
  });
});

describe("read-projection pure functions (v0.1.8)", () => {
  it("projectStateResult drops globals and filters per-domain facets to the allowlist", () => {
    const payload = {
      state: {
        core_identity: { display_name: "owner" },
        global_preferences: { custom: { secret: "PLANTED" } },
        active_projects: [
          { project_id: "a", domain: "coding" },
          { project_id: "b", domain: "personal" },
        ],
        domain_context: { coding: { framework: "x" }, personal: { mood: "y" } },
        recent_timeline: [
          { event_id: "1", domain: "coding" },
          { event_id: "2", domain: "personal" },
        ],
      },
    };
    const out = projectStateResult(payload, ["coding"]);
    expect(out.state.core_identity).toBeUndefined();
    expect(out.state.global_preferences).toBeUndefined();
    expect(out.state.active_projects).toEqual([{ project_id: "a", domain: "coding" }]);
    expect(out.state.domain_context).toEqual({ coding: { framework: "x" } });
    expect(out.state.recent_timeline).toEqual([{ event_id: "1", domain: "coding" }]);
  });

  it("projectSearchResult filters events and recomputes result_count (no out-of-scope volume leak)", () => {
    const out = projectSearchResult(
      {
        query: "q",
        result_count: 3,
        events: [
          { event_id: "1", domain: "coding" },
          { event_id: "2", domain: "personal" },
          { event_id: "3", domain: "coding" },
        ],
      },
      ["coding"],
    );
    expect(out.result_count).toBe(2);
    expect(out.events.every((e: any) => e.domain === "coding")).toBe(true);
    expect(out.query).toBe("q");
  });

  it("filterEventsToScopes fails closed on events with no resolvable domain", () => {
    const events = [
      { event_id: "1", domain: "coding" },
      { event_id: "2" }, // no domain — must be dropped, not passed through
      { event_id: "3", domain: undefined },
    ];
    expect(filterEventsToScopes(events as any, ["coding"])).toEqual([
      { event_id: "1", domain: "coding" },
    ]);
  });

  it("buildScopedStatusPayload emits only the scope-safe envelope fields", () => {
    const out = buildScopedStatusPayload({
      usrcp_version: "0.1.7",
      user_id: "usrcp://local/u_x",
      stats: { total_events: 2, domains: ["coding"], platforms: ["cli"], encryption_enabled: true },
      active_projects: 1,
      allowed_domains: ["coding"],
    });
    expect(out.scoped).toBe(true);
    expect(out.allowed_domains).toEqual(["coding"]);
    expect(out.active_projects).toBe(1);
    expect(out.ledger).toBe("local (SQLite)");
    // Unscoped-only aggregates must never appear in the scoped envelope.
    expect(out).not.toHaveProperty("total_projects");
    expect(out).not.toHaveProperty("db_size_bytes");
    expect(out).not.toHaveProperty("audit_log_entries");
  });
});
