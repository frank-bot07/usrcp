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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-tamper-"));
  process.env.HOME = tmpHome;
  dbPath = path.join(tmpHome, "tamper-test.db");
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("Tamper Detection", () => {
  it("returns tampered=true for corrupted event fields", () => {
    ledger.appendEvent(
      {
        domain: "test",
        summary: "Clean event",
        intent: "test",
        outcome: "success",
        detail: { secret: "data" },
      },
      "test"
    );

    // Corrupt the detail field
    const event = ledger.getTimeline({ last_n: 1 })[0];
    const raw = (ledger as any).db
      .prepare("SELECT detail FROM timeline_events WHERE event_id = ?")
      .get(event.event_id) as any;

    // Flip a byte in the ciphertext
    const parts = raw.detail.split(":");
    const buf = Buffer.from(parts[1], "base64");
    buf[buf.length - 5] ^= 0xff;
    const corrupted = "enc:" + buf.toString("base64");
    (ledger as any).db
      .prepare("UPDATE timeline_events SET detail = ? WHERE event_id = ?")
      .run(corrupted, event.event_id);

    // Reading the event should return tampered flag, not crash
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events).toHaveLength(1);
    expect((events[0] as any).tampered).toBe(true);
    expect(events[0].detail).toEqual({});
  });

  it("marks individual tampered fields while preserving clean ones", () => {
    ledger.appendEvent(
      {
        domain: "test",
        summary: "Good summary",
        intent: "Good intent",
        outcome: "success",
      },
      "test"
    );

    const event = ledger.getTimeline({ last_n: 1 })[0];

    // Corrupt only the intent field
    const raw = (ledger as any).db
      .prepare("SELECT intent FROM timeline_events WHERE event_id = ?")
      .get(event.event_id) as any;
    if (raw.intent && raw.intent.startsWith("enc:")) {
      const buf = Buffer.from(raw.intent.split(":")[1], "base64");
      buf[buf.length - 5] ^= 0xff;
      (ledger as any).db
        .prepare("UPDATE timeline_events SET intent = ? WHERE event_id = ?")
        .run("enc:" + buf.toString("base64"), event.event_id);
    }

    const events = ledger.getTimeline({ last_n: 1 });
    expect(events[0].summary).toBe("Good summary"); // Not tampered
    expect(events[0].intent).toBe("[TAMPERED]"); // Tampered
    expect((events[0] as any).tampered).toBe(true);
  });

  it("logs tamper events to audit log", () => {
    ledger.appendEvent(
      {
        domain: "test",
        summary: "Event",
        intent: "test",
        outcome: "success",
        detail: { key: "value" },
      },
      "test"
    );

    // Corrupt detail
    const event = ledger.getTimeline({ last_n: 1 })[0];
    const raw = (ledger as any).db
      .prepare("SELECT detail FROM timeline_events WHERE event_id = ?")
      .get(event.event_id) as any;
    const buf = Buffer.from(raw.detail.split(":")[1], "base64");
    buf[buf.length - 5] ^= 0xff;
    (ledger as any).db
      .prepare("UPDATE timeline_events SET detail = ? WHERE event_id = ?")
      .run("enc:" + buf.toString("base64"), event.event_id);

    // Read — triggers tamper detection
    ledger.getTimeline({ last_n: 1 });

    // Check audit log for tamper entry
    const audit = ledger.getAuditLog(20);
    const tamperEntries = audit.filter(
      (e: any) => e.operation === "tamper_detected"
    );
    expect(tamperEntries.length).toBeGreaterThan(0);
  });

  it("caps tamper audit log entries per session", () => {
    // Create events with corrupted fields
    for (let i = 0; i < 15; i++) {
      ledger.appendEvent(
        {
          domain: "test",
          summary: `Event ${i}`,
          intent: "test",
          outcome: "success",
          detail: { idx: i },
        },
        "test"
      );
    }

    // Corrupt all detail fields
    const events = ledger.getTimeline({ last_n: 15 });
    for (const event of events) {
      const raw = (ledger as any).db
        .prepare("SELECT detail FROM timeline_events WHERE event_id = ?")
        .get(event.event_id) as any;
      if (raw.detail && raw.detail.startsWith("enc:")) {
        const buf = Buffer.from(raw.detail.split(":")[1], "base64");
        buf[buf.length - 5] ^= 0xff;
        (ledger as any).db
          .prepare("UPDATE timeline_events SET detail = ? WHERE event_id = ?")
          .run("enc:" + buf.toString("base64"), event.event_id);
      }
    }

    // Read all — triggers many tamper detections
    ledger.getTimeline({ last_n: 15 });

    // Check that tamper audit entries are capped
    const audit = ledger.getAuditLog(100);
    const tamperEntries = audit.filter(
      (e: any) => e.operation === "tamper_detected"
    );
    const capEntries = audit.filter(
      (e: any) => e.operation === "tamper_flood_capped"
    );

    // Should have at most 10 tamper entries + 1 cap entry
    expect(tamperEntries.length).toBeLessThanOrEqual(10);
    expect(capEntries.length).toBeLessThanOrEqual(1);
  });

  // Regression for the read-path crash discovered during the Discord
  // vision-proof demo: rotation tamper-tolerance (PR #2) lets domain_map
  // entries legitimately carry ciphertext encrypted by a previous master
  // key. resolveDomain() used to call the throwing decryptGlobal, so any
  // timeline read crashed with "Unsupported state or unable to authenticate
  // data". Now uses decryptGlobalSafe with the pseudonym as fallback.
  it("getTimeline tolerates a corrupted domain_map entry without throwing", () => {
    ledger.appendEvent(
      {
        domain: "discord",
        summary: "captured a message",
        intent: "test",
        outcome: "success",
      },
      "test"
    );

    // The append above wrote a domain_map row for "discord". Corrupt its
    // encrypted_name (simulates a rotation-skipped entry on stale key).
    const row = (ledger as any).db
      .prepare("SELECT pseudonym, encrypted_name FROM domain_map LIMIT 1")
      .get() as { pseudonym: string; encrypted_name: string };
    expect(row).toBeTruthy();
    expect(row.encrypted_name.startsWith("enc:")).toBe(true);

    const parts = row.encrypted_name.split(":");
    const buf = Buffer.from(parts[1], "base64");
    buf[buf.length - 5] ^= 0xff;
    const corrupted = "enc:" + buf.toString("base64");
    (ledger as any).db
      .prepare("UPDATE domain_map SET encrypted_name = ? WHERE pseudonym = ?")
      .run(corrupted, row.pseudonym);

    // The read path must NOT throw; the pseudonym is the fallback domain.
    const events = ledger.getTimeline({ last_n: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].domain).toBe(row.pseudonym);
  });
});
