import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ledger } from "usrcp-core/ledger";
import { setUserSlug } from "usrcp-core/encryption";
import { registerStreamTools, type StreamRegistration } from "../register.js";

// Codex P1-4: when entity_refs is not supplied, capture should scan content
// for active project names via the linked Ledger and backfill the refs.

type AnyServer = McpServer & {
  _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ content: { text: string }[] }> }>;
};

let tmpHome: string;
let origHome: string | undefined;
let masterKey: Buffer;
let ledger: Ledger;
let server: McpServer;
let registration: StreamRegistration;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-stream-entity-"));
  process.env.HOME = tmpHome;
  setUserSlug("default");
  ledger = new Ledger(path.join(tmpHome, "ledger.db"));
  masterKey = ledger.getMasterKey();
  server = new McpServer({ name: "t", version: "0" });
  registration = registerStreamTools(server, {
    masterKey,
    userDir: tmpHome,
    ledger,
    embedder: null,
  });
});

afterEach(() => {
  try { registration.shutdown(); } catch { /* */ }
  try { ledger.close(); } catch { /* */ }
  process.env.HOME = origHome;
  setUserSlug("default");
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("entity-resolution (Codex P1-4)", () => {
  it("backfills entity_refs from active projects when caller omits them", async () => {
    ledger.upsertProject({
      project_id: "p_solTrader",
      name: "Sol-Trader",
      domain: "trading",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "intraday trader",
    });
    ledger.upsertProject({
      project_id: "p_baking",
      name: "Baking",
      domain: "personal",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "weekend baking",
    });

    const tools = (server as AnyServer)._registeredTools;
    const cap = await tools.stream_capture.handler({
      surface: "discord",
      channel_ref: { g: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "Quick question about the Sol-Trader retry policy",
      content_kind: "text",
      ts_ms: Date.now(),
      // entity_refs INTENTIONALLY omitted
    });
    const body = JSON.parse(cap.content[0].text);
    expect(body.status).toBe("ok");

    // The captured row's entity_refs (encrypted) must decrypt to a list
    // that includes p_solTrader.
    const row = registration.handle.db.prepare("SELECT entity_refs FROM events WHERE event_uuid = ?")
      .get(body.event_uuid) as { entity_refs: string | null };
    expect(row.entity_refs).not.toBeNull();
    expect(row.entity_refs!.startsWith("enc:")).toBe(true);
    const { decryptJsonFromColumn } = await import("../db/encrypted-row.js");
    const refs = decryptJsonFromColumn<string[]>(masterKey, "events", row.entity_refs!);
    expect(refs).toContain("p_solTrader");
    expect(refs).not.toContain("p_baking");
  });

  it("does not overwrite caller-supplied entity_refs", async () => {
    ledger.upsertProject({
      project_id: "p_solTrader",
      name: "Sol-Trader",
      domain: "trading",
      status: "active",
      last_touched: new Date().toISOString(),
      summary: "",
    });

    const tools = (server as AnyServer)._registeredTools;
    const cap = await tools.stream_capture.handler({
      surface: "discord",
      channel_ref: { g: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "Quick question about the Sol-Trader retry policy",
      content_kind: "text",
      ts_ms: Date.now(),
      entity_refs: ["p_explicit"],
    });
    const body = JSON.parse(cap.content[0].text);

    const row = registration.handle.db.prepare("SELECT entity_refs FROM events WHERE event_uuid = ?")
      .get(body.event_uuid) as { entity_refs: string };
    const { decryptJsonFromColumn } = await import("../db/encrypted-row.js");
    const refs = decryptJsonFromColumn<string[]>(masterKey, "events", row.entity_refs);
    expect(refs).toEqual(["p_explicit"]);  // caller wins; resolver does not augment
  });

  it("standalone mode (no ledger) leaves entity_refs untouched when caller omits them", async () => {
    // Tear down the unified-mode setup; rebuild with no ledger.
    registration.shutdown();
    server = new McpServer({ name: "t", version: "0" });
    registration = registerStreamTools(server, {
      masterKey,
      userDir: tmpHome,
      embedder: null,
      // no ledger
    });

    const tools = (server as AnyServer)._registeredTools;
    const cap = await tools.stream_capture.handler({
      surface: "discord",
      channel_ref: { g: "1" },
      side: "inbound",
      author_ref: { id: "u1" },
      content: "would-be matchable Sol-Trader content",
      content_kind: "text",
      ts_ms: Date.now(),
    });
    const body = JSON.parse(cap.content[0].text);
    const row = registration.handle.db.prepare("SELECT entity_refs FROM events WHERE event_uuid = ?")
      .get(body.event_uuid) as { entity_refs: string | null };
    expect(row.entity_refs).toBeNull();
  });
});
