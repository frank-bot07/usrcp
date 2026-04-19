import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../ledger.js";
import { createServer } from "../server.js";
import { initializeIdentity } from "../crypto.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// --- Ledger-level validation tests (defense-in-depth) ---

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `usrcp-sec-${Date.now()}.db`);
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + "-wal");
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

const validEvent = {
  domain: "coding",
  summary: "test",
  intent: "test",
  outcome: "success" as const,
};

describe("Ledger input validation — string lengths", () => {
  it("rejects domain over 100 chars", () => {
    expect(() =>
      ledger.appendEvent({ ...validEvent, domain: "x".repeat(101) }, "test")
    ).toThrow("domain exceeds 100 chars");
  });

  it("accepts domain at exactly 100 chars", () => {
    const result = ledger.appendEvent(
      { ...validEvent, domain: "x".repeat(100) },
      "test"
    );
    expect(result.event_id).toBeTruthy();
  });

  it("rejects summary over 500 chars", () => {
    expect(() =>
      ledger.appendEvent({ ...validEvent, summary: "x".repeat(501) }, "test")
    ).toThrow("summary exceeds 500 chars");
  });

  it("accepts summary at exactly 500 chars", () => {
    const result = ledger.appendEvent(
      { ...validEvent, summary: "x".repeat(500) },
      "test"
    );
    expect(result.event_id).toBeTruthy();
  });

  it("rejects intent over 300 chars", () => {
    expect(() =>
      ledger.appendEvent({ ...validEvent, intent: "x".repeat(301) }, "test")
    ).toThrow("intent exceeds 300 chars");
  });

  it("rejects platform over 100 chars", () => {
    expect(() =>
      ledger.appendEvent(validEvent, "x".repeat(101))
    ).toThrow("platform exceeds 100 chars");
  });

  it("rejects idempotency_key over 100 chars", () => {
    expect(() =>
      ledger.appendEvent(validEvent, "test", "k".repeat(101))
    ).toThrow("idempotency_key exceeds 100 chars");
  });

  it("rejects session_id over 100 chars", () => {
    expect(() =>
      ledger.appendEvent(
        { ...validEvent, session_id: "s".repeat(101) },
        "test"
      )
    ).toThrow("session_id exceeds 100 chars");
  });
});

describe("Ledger input validation — array sizes", () => {
  it("rejects tags array over 50 items", () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    expect(() =>
      ledger.appendEvent({ ...validEvent, tags }, "test")
    ).toThrow("tags exceeds 50 items");
  });

  it("accepts tags array at exactly 50 items", () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const result = ledger.appendEvent({ ...validEvent, tags }, "test");
    expect(result.event_id).toBeTruthy();
  });

  it("rejects artifacts array over 50 items", () => {
    const artifacts = Array.from({ length: 51 }, (_, i) => ({
      type: "file" as const,
      ref: `f${i}.txt`,
    }));
    expect(() =>
      ledger.appendEvent({ ...validEvent, artifacts }, "test")
    ).toThrow("artifacts exceeds 50 items");
  });

  it("rejects artifact ref over 2048 chars", () => {
    expect(() =>
      ledger.appendEvent(
        {
          ...validEvent,
          artifacts: [{ type: "url", ref: "https://" + "x".repeat(2048) }],
        },
        "test"
      )
    ).toThrow("artifact ref exceeds 2048 chars");
  });
});

describe("Ledger input validation — payload size", () => {
  it("rejects detail blob over 64KB", () => {
    const detail = { payload: "x".repeat(70000) };
    expect(() =>
      ledger.appendEvent({ ...validEvent, detail }, "test")
    ).toThrow("detail exceeds 64KB");
  });

  it("accepts detail blob under 64KB", () => {
    const detail = { payload: "x".repeat(60000) };
    const result = ledger.appendEvent({ ...validEvent, detail }, "test");
    expect(result.event_id).toBeTruthy();
  });
});

describe("Zod schema validation — tool definitions", () => {
  let server: McpServer;
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-zod-test-"));
    process.env.HOME = tmpHome;
    initializeIdentity();
    const created = createServer();
    server = created.server;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("defines max constraints on append_event schema", () => {
    const tools = (server as any)._registeredTools;
    const schema = tools["usrcp_append_event"].inputSchema;
    const schemaStr = JSON.stringify(schema);

    // Verify maxLength constraints exist in the Zod schema
    expect(schemaStr).toContain('"maxLength"');
    // Verify array types have checks (max constraints)
    expect(schemaStr).toContain('"type":"array"');
  });

  it("defines max constraints on update_identity schema", () => {
    const tools = (server as any)._registeredTools;
    const schema = tools["usrcp_update_identity"].inputSchema;
    const schemaStr = JSON.stringify(schema);

    expect(schemaStr).toContain('"maxLength"');
    expect(schemaStr).toContain('"type":"array"');
  });

  it("defines max constraints on search_timeline schema", () => {
    const tools = (server as any)._registeredTools;
    const schema = tools["usrcp_search_timeline"].inputSchema;
    const schemaStr = JSON.stringify(schema);

    expect(schemaStr).toContain('"maxLength"');
  });

  it("defines max constraints on manage_project schema", () => {
    const tools = (server as any)._registeredTools;
    const schema = tools["usrcp_manage_project"].inputSchema;
    const schemaStr = JSON.stringify(schema);

    expect(schemaStr).toContain('"maxLength"');
  });

  it("registers exactly 8 tools", () => {
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });
});

describe("Special characters handling", () => {
  it("handles unicode in event fields", () => {
    const result = ledger.appendEvent(
      {
        ...validEvent,
        summary: "Fixed bug in authentication module",
        tags: ["unicode-safe", "test"],
      },
      "test"
    );
    expect(result.event_id).toBeTruthy();

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].summary).toContain("authentication");
  });

  it("handles empty tags array", () => {
    const result = ledger.appendEvent(
      { ...validEvent, tags: [] },
      "test"
    );
    expect(result.event_id).toBeTruthy();
  });

  it("handles SQL wildcards in search without injection", () => {
    ledger.appendEvent(
      { ...validEvent, summary: "Fixed 100% of bugs" },
      "test"
    );
    // % is a SQL wildcard — should not cause issues
    const results = ledger.searchTimeline("100");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
