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

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type ScopedToolDef,
  type ServeOptions,
  outOfScopeResponse,
  registerToolsWithScopes,
  resolveScopes,
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
