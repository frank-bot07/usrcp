import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../ledger/index.js";

let ledger: Ledger;
let dbPath: string;
let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-audit-test-"));
  process.env.HOME = tmpHome;
  dbPath = path.join(tmpHome, "audit-test.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("Audit log", () => {
  it("logs append_event operations", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "test", intent: "test", outcome: "success" },
      "test"
    );

    const log = ledger.getAuditLog();
    const appendEntries = log.filter((e: any) => e.operation === "append_event");
    expect(appendEntries.length).toBe(1);
    // Domain is stored as pseudonym in audit — just verify it's present
    expect(appendEntries[0].scopes_accessed).toBeTruthy();
  });

  it("logs get_state operations with scopes", () => {
    ledger.getState(["core_identity", "global_preferences"]);

    const log = ledger.getAuditLog();
    const getEntries = log.filter((e: any) => e.operation === "get_state");
    expect(getEntries.length).toBe(1);
    expect(getEntries[0].scopes_accessed).toContain("core_identity");
    expect(getEntries[0].scopes_accessed).toContain("global_preferences");
  });

  it("logs get_timeline operations", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "test"
    );
    ledger.getTimeline({ last_n: 10 });

    const log = ledger.getAuditLog();
    const timelineEntries = log.filter(
      (e: any) => e.operation === "get_timeline"
    );
    expect(timelineEntries.length).toBe(1);
    expect(timelineEntries[0].response_size_bytes).toBeGreaterThan(0);
  });

  it("logs update_domain_context operations", () => {
    ledger.upsertDomainContext("coding", { key: "value" });

    const log = ledger.getAuditLog();
    const ctxEntries = log.filter(
      (e: any) => e.operation === "update_domain_context"
    );
    expect(ctxEntries.length).toBe(1);
    expect(ctxEntries[0].scopes_accessed).toBeTruthy();
  });

  it("logs delete operations with affected event IDs", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "test"
    );
    const event = ledger.getTimeline({ last_n: 1 })[0];

    // Backdate and delete
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    (ledger as any).db
      .prepare("UPDATE timeline_events SET timestamp = ? WHERE event_id = ?")
      .run(oldDate.toISOString(), event.event_id);

    ledger.deleteOldEvents(90);

    const log = ledger.getAuditLog();
    const deleteEntries = log.filter(
      (e: any) => e.operation === "delete_old_events"
    );
    expect(deleteEntries.length).toBe(1);
    expect(deleteEntries[0].event_ids).toContain(event.event_id);
  });

  it("records timestamps on all entries", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "test"
    );

    const log = ledger.getAuditLog();
    expect(log.length).toBeGreaterThan(0);
    log.forEach((entry: any) => {
      expect(entry.timestamp).toBeTruthy();
    });
  });

  it("limits audit log results", () => {
    for (let i = 0; i < 10; i++) {
      ledger.appendEvent(
        { domain: "coding", summary: `e${i}`, intent: "i", outcome: "success" },
        "test"
      );
    }

    const log = ledger.getAuditLog(3);
    expect(log).toHaveLength(3);
  });

  it("includes audit_log_entries in stats", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "test"
    );
    const stats = ledger.getStats();
    expect(stats.audit_log_entries).toBeGreaterThan(0);
    expect(stats.encryption_enabled).toBe(true);
  });
});

describe("Secure delete", () => {
  it("secureWipe runs without error", () => {
    ledger.appendEvent(
      { domain: "coding", summary: "e1", intent: "i", outcome: "success" },
      "test"
    );
    expect(() => ledger.secureWipe()).not.toThrow();
  });

  it("secure_delete pragma is enabled", () => {
    const result = (ledger as any).db.pragma("secure_delete") as any[];
    expect(result[0].secure_delete).toBe(1);
  });
});
